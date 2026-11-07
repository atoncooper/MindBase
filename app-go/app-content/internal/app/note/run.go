// Package note hosts the note domain runner inside app-content.
package note

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	notecfg "app-content/internal/config/note"
	notedb "app-content/internal/infra/db/note"
	notemongo "app-content/internal/infra/mongostore/note"
	noterepo "app-content/internal/repo/note"
	noterouter "app-content/internal/router/note"
	noteservice "app-content/internal/service/note"
)

// Run starts the note engine (8008) and blocks until ctx is canceled or the
// server fails.
func Run(ctx context.Context, cfg *notecfg.Config) error {
	if err := notecfg.Validate(cfg); err != nil {
		return fmt.Errorf("note config: %w", err)
	}
	if err := notedb.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns,
		cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		return fmt.Errorf("note mysql: %w", err)
	}
	defer notedb.Close()
	if err := notedb.Migrate(); err != nil {
		return fmt.Errorf("note migrate: %w", err)
	}
	mongoStore, err := notemongo.NewMongoStore(ctx, cfg)
	if err != nil {
		return fmt.Errorf("note mongo: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mongoStore.Close(closeCtx)
	}()
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure note indexes failed (continuing)", "err", err)
	}
	contentRepo := noterepo.NewMongoContentRepo(mongoStore.Database())
	handler := noterouter.New(noterouter.Deps{
		Cfg:     cfg,
		DB:      notedb.DB,
		Content: contentRepo,
		Notes:   noteservice.NewNoteService(noterepo.NewNoteRepo(), contentRepo),
	})

	srv := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port), Handler: handler}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("app-content note listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
		return shutdown(srv)
	case err := <-errCh:
		_ = shutdown(srv)
		return fmt.Errorf("note server: %w", err)
	}
}

func shutdown(srv *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("note shutdown: %w", err)
	}
	return nil
}
