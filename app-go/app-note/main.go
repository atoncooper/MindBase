// app-note entrypoint: load config, init MySQL + Mongo, ensure indexes,
// start the Gin HTTP server, graceful shutdown.
//
// Notes service: CRUD, anchors, revisions, sharing for user markdown
// notes. Run from project root: go run ./app-go/app-note
package main

import (
	"context"
	_ "embed" // embed default.yaml via //go:embed below
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-note/internal/config"
	"app-note/internal/db"
	"app-note/internal/logger"
	"app-note/internal/mongostore"
	"app-note/internal/repo"
	"app-note/internal/router"
	"app-note/internal/service"
)

//go:embed default.yaml
var defaultYAML []byte

func main() {
	cfg, err := config.Load(defaultYAML)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

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
	slog.Info("app-note starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}

	// MySQL — shared bilirag database; schema ownership via db.Migrate below.
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns,
		cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	// Mongo — note content + revisions (optional at boot; reads degrade,
	// writes fail per-request when absent, same as the Python backend).
	// Connection lifecycle lives in mongostore; collection operations in
	// repo.MongoContentRepo (mirrors the db/repo split of MySQL).
	ctx := context.Background()
	mongoStore, err := mongostore.NewMongoStore(ctx, cfg)
	if err != nil {
		slog.Warn("[MONGO] unavailable at boot — note writes will fail until it recovers", "err", err)
		mongoStore = &mongostore.MongoStore{}
	}
	defer mongoStore.Close(ctx)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure indexes failed (continuing — indexes may already exist)", "err", err)
	}
	contentRepo := repo.NewMongoContentRepo(mongoStore.Database())

	// Business timezone.
	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	handler := router.New(router.Deps{
		Cfg:     cfg,
		DB:      db.DB,
		Content: contentRepo,
		Notes:   service.NewNoteService(repo.NewNoteRepo(), contentRepo),
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-note listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
	slog.Info("app-note stopped")
}
