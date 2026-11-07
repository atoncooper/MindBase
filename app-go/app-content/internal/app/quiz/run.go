// Package quiz hosts the quiz domain runner inside app-content.
package quiz

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	quizcfg "app-content/internal/config/quiz"
	quizdb "app-content/internal/infra/db/quiz"
	quizmongo "app-content/internal/infra/mongostore/quiz"
	quizredis "app-content/internal/infra/redisstore/quiz"
	quizrouter "app-content/internal/router/quiz"
	quizservice "app-content/internal/service/quiz"
)

// Run starts the quiz engine (8011) and blocks until ctx is canceled or the
// server fails.
func Run(ctx context.Context, cfg *quizcfg.Config) error {
	if err := quizcfg.Validate(cfg); err != nil {
		return fmt.Errorf("quiz config: %w", err)
	}
	if err := quizdb.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns,
		cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		return fmt.Errorf("quiz mysql: %w", err)
	}
	defer quizdb.Close()
	if err := quizdb.Migrate(); err != nil {
		return fmt.Errorf("quiz migrate: %w", err)
	}
	mongoStore, err := quizmongo.NewMongoStore(ctx, cfg)
	if err != nil {
		return fmt.Errorf("quiz mongo: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mongoStore.Close(closeCtx)
	}()
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure quiz indexes failed (continuing)", "err", err)
	}
	redisStore, err := quizredis.New(ctx, cfg)
	if err != nil {
		return fmt.Errorf("quiz redis: %w", err)
	}
	defer redisStore.Close()

	quizSvc := quizservice.New(quizdb.DB, mongoStore.Database(), redisStore)
	quizSvc.Quota = redisStore
	quizSvc.QuotaLimits = map[string]int{"generate": cfg.Quota.Generate, "grade": cfg.Quota.Grade}
	quizSvc.GenTimeoutBase = time.Duration(cfg.Lifecycle.GenerationTimeoutMinutes) * time.Minute
	handler := quizrouter.New(quizrouter.Deps{Cfg: cfg, DB: quizdb.DB, Quiz: quizSvc})

	srv := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port), Handler: handler}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("app-content quiz listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
		return shutdown(srv)
	case err := <-errCh:
		_ = shutdown(srv)
		return fmt.Errorf("quiz server: %w", err)
	}
}

func shutdown(srv *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("quiz shutdown: %w", err)
	}
	return nil
}
