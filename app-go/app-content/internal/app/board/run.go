// Package board hosts the board domain runner inside app-content.
package board

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	boardcfg "app-content/internal/config/board"
	boardcache "app-content/internal/infra/cache/board"
	boarddb "app-content/internal/infra/db/board"
	boardmongo "app-content/internal/infra/mongo/board"
	appboardtls "app-content/internal/infra/tls/board"
	boardrepo "app-content/internal/repo/board"
	boardrouter "app-content/internal/router/board"
	boardservice "app-content/internal/service/board"
)

// Run starts the board engine (8004, HTTPS as configured) and blocks until
// ctx is canceled or the server fails.
func Run(ctx context.Context, cfg *boardcfg.Config) error {
	boardcfg.Defaults(cfg)
	if err := boardcfg.Validate(cfg); err != nil {
		return fmt.Errorf("board config: %w", err)
	}
	if err := boarddb.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns, cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		return fmt.Errorf("board mysql: %w", err)
	}
	defer boarddb.Close()
	if err := boarddb.Migrate(); err != nil {
		return fmt.Errorf("board migrate: %w", err)
	}
	if err := boardmongo.Init(cfg.Mongo.URI, cfg.Mongo.DBName, cfg.Mongo.Timeout); err != nil {
		return fmt.Errorf("board mongo: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = boardmongo.Close(closeCtx)
	}()

	var readCache boardcache.CacheStore = boardcache.NoopCache{}
	if strings.TrimSpace(cfg.Redis.URL) != "" {
		opts, err := redis.ParseURL(cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("board redis url: %w", err)
		}
		ttl := time.Duration(cfg.Redis.CacheTTLSeconds) * time.Second
		if ttl <= 0 {
			ttl = 300 * time.Second
		}
		readCache = boardcache.NewRedis(redis.NewClient(opts), ttl)
	}
	meta := &boardrepo.BoardRepo{DB: boarddb.DB}
	docs := &boardrepo.MongoDocRepo{Col: boardmongo.DB.Collection("board_documents")}
	svc := boardservice.NewBoardService(meta, docs, readCache)
	handler := boardrouter.New(svc, cfg)

	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:           handler,
		ReadHeaderTimeout: time.Duration(cfg.Server.ReadHeaderTimeoutSeconds) * time.Second,
		ReadTimeout:       time.Duration(cfg.Server.ReadTimeoutSeconds) * time.Second,
		WriteTimeout:      time.Duration(cfg.Server.WriteTimeoutSeconds) * time.Second,
		IdleTimeout:       time.Duration(cfg.Server.IdleTimeoutSeconds) * time.Second,
		MaxHeaderBytes:    cfg.Server.MaxHeaderBytes,
	}
	var stopRotator chan struct{}
	if cfg.Server.TLS.Enabled {
		rotator, err := appboardtls.NewRotator(cfg.Server.TLS.Cert, cfg.Server.TLS.Key, cfg.Server.TLS.CertDir)
		if err != nil {
			return fmt.Errorf("board tls: %w", err)
		}
		rotator.Summary()
		stopRotator = make(chan struct{})
		rotator.Start(stopRotator)
		defer close(stopRotator)
		srv.TLSConfig = &tls.Config{
			MinVersion: tls.VersionTLS12,
			GetCertificate: func(chi *tls.ClientHelloInfo) (*tls.Certificate, error) {
				return rotator.GetCertificate(chi)
			},
		}
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("app-content board listening", "addr", srv.Addr, "tls", cfg.Server.TLS.Enabled)
		var err error
		if cfg.Server.TLS.Enabled {
			err = srv.ListenAndServeTLS("", "")
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		return shutdown(srv)
	case err := <-errCh:
		_ = shutdown(srv)
		return fmt.Errorf("board server: %w", err)
	}
}

func shutdown(srv *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("board shutdown: %w", err)
	}
	return nil
}
