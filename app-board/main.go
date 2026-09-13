// app-board entrypoint: load config, init MySQL + Mongo, resolve TLS
// certificate, serve HTTPS with graceful shutdown. Content store for mind
// maps and whiteboards. Run from project root: go run ./app-board
package main

import (
	"context"
	"crypto/tls"
	_ "embed" // embed default.yaml via //go:embed below
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"app-board/internal/cache"
	"app-board/internal/config"
	"app-board/internal/db"
	"app-board/internal/logger"
	"app-board/internal/mongo"
	"app-board/internal/repo"
	"app-board/internal/router"
	"app-board/internal/service"
	appboardtls "app-board/internal/tls"
)

//go:embed default.yaml
var defaultYAML []byte

func main() {
	cfg, err := config.Load(defaultYAML)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	// Logging (slog; level/format from log config, debug flag bumps info->debug)
	logLevel := cfg.Log.Level
	if logLevel == "" {
		logLevel = "info"
	}
	if cfg.App.Debug && logLevel == "info" {
		logLevel = "debug"
	}
	logger.Init(logger.Options{
		Level:  logLevel,
		Format: cfg.Log.Format,
		Output: cfg.Log.Output,
		File: logger.FileOptions{
			Path:       cfg.Log.File.Path,
			MaxSize:    cfg.Log.File.MaxSize,
			MaxBackups: cfg.Log.File.MaxBackups,
			MaxAge:     cfg.Log.File.MaxAge,
			Compress:   cfg.Log.File.Compress,
		},
	})
	slog.Info("app-board starting", "port", cfg.Server.Port, "tls", cfg.Server.TLS.Enabled)

	// Apply runtime fallbacks (timeouts etc.) before any consumer sees cfg.
	config.Defaults(cfg)

	// Validate critical config: fail loud instead of silently broken.
	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}

	// MySQL (GORM) — main app's instance/database; the board table is
	// app-board-owned schema, created via db.Migrate below.
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns, cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	// MongoDB — main app's instance (db MindBase), board bodies collection.
	if err := mongo.Init(cfg.Mongo.URI, cfg.Mongo.DBName, cfg.Mongo.Timeout); err != nil {
		slog.Error("init mongo failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mongo.Close(ctx)
	}()

	// Services: metadata (MySQL) + bodies (Mongo) + optional Redis read cache.
	// Redis is an optimization, NOT a dependency: URL unset = cache disabled;
	// Redis down at runtime = every cache op degrades to a miss and the
	// request falls through to the stores (correctness never depends on it).
	var readCache cache.CacheStore = cache.NoopCache{}
	if strings.TrimSpace(cfg.Redis.URL) != "" {
		opts, err := redis.ParseURL(cfg.Redis.URL)
		if err != nil {
			slog.Error("parse redis url failed", "err", err)
			os.Exit(1)
		}
		ttl := time.Duration(cfg.Redis.CacheTTLSeconds) * time.Second
		if ttl <= 0 {
			ttl = 300 * time.Second
		}
		readCache = cache.NewRedis(redis.NewClient(opts), ttl)
		slog.Info("[CACHE] redis read cache enabled", "db", opts.DB, "ttl", ttl.String())
	} else {
		slog.Info("[CACHE] redis read cache disabled (redis.url empty)")
	}
	meta := &repo.BoardRepo{DB: db.DB}
	docs := &repo.MongoDocRepo{Col: mongo.DB.Collection("board_documents")}
	svc := service.NewBoardService(meta, docs, readCache)

	// TLS: HTTPS-only. Auto mode generates a dev CA + leaf under cert_dir;
	// the CA cert is what APISIX mounts as the tls_verify trust anchor.
	// HTTP server (Gin) with explicit connection/timeout policy: without
	// Read/Idle timeouts a slow client pins its goroutine and TLS channel
	// forever; IdleTimeout bounds the keep-alive connection pool.
	handler := router.New(svc, cfg)
	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:           handler,
		ReadHeaderTimeout: time.Duration(cfg.Server.ReadHeaderTimeoutSeconds) * time.Second,
		ReadTimeout:       time.Duration(cfg.Server.ReadTimeoutSeconds) * time.Second,
		WriteTimeout:      time.Duration(cfg.Server.WriteTimeoutSeconds) * time.Second,
		IdleTimeout:       time.Duration(cfg.Server.IdleTimeoutSeconds) * time.Second,
		MaxHeaderBytes:    cfg.Server.MaxHeaderBytes,
	}
	if cfg.Server.TLS.Enabled {
		rotator, err := appboardtls.NewRotator(cfg.Server.TLS.Cert, cfg.Server.TLS.Key, cfg.Server.TLS.CertDir)
		if err != nil {
			slog.Error("resolve tls certificate failed", "err", err)
			os.Exit(1)
		}
		rotator.Summary()
		stop := make(chan struct{})
		rotator.Start(stop)
		defer close(stop)
		srv.TLSConfig = &tls.Config{
			// Certificate lives in the rotator (hot-swappable); MinVersion
			// drops legacy protocol/ cipher suites.
			MinVersion:   tls.VersionTLS12,
			Certificates: nil,
			GetCertificate: func(chi *tls.ClientHelloInfo) (*tls.Certificate, error) {
				return rotator.GetCertificate(chi)
			},
		}
	}

	addr := srv.Addr
	go func() {
		slog.Info("app-board listening", "addr", addr, "scheme", schemeName(cfg.Server.TLS.Enabled))
		var err error
		if cfg.Server.TLS.Enabled {
			// Empty cert files: the certificate comes from TLSConfig.GetCertificate.
			err = srv.ListenAndServeTLS("", "")
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			slog.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	slog.Info("app-board stopped")
}

func schemeName(tlsEnabled bool) string {
	if tlsEnabled {
		return "https"
	}
	return "http"
}
