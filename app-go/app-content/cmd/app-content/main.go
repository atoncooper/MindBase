// app-content entrypoint: the consolidated content-domain service. It hosts
// three independent Gin engines on the legacy ports so external contracts are
// unchanged: 8004 = board (HTTPS), 8008 = notes, 8011 = quiz. Domains share
// one process, one image, one embedded default.yaml and one global logger.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"

	_ "time/tzdata"

	"app-content/internal/app/board"
	"app-content/internal/app/note"
	"app-content/internal/app/quiz"
	"app-content/internal/config"
	"app-content/internal/logger"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fatal("load config", err)
	}

	logLevel := cfg.Board.Log.Level
	if logLevel == "" {
		logLevel = "info"
	}
	if cfg.Board.App.Debug && logLevel == "info" {
		logLevel = "debug"
	}
	logger.Init(logger.Options{
		Level:  logLevel,
		Format: cfg.Board.Log.Format,
		Output: cfg.Board.Log.Output,
		File: logger.FileOptions{
			Path:       cfg.Board.Log.File.Path,
			MaxSize:    cfg.Board.Log.File.MaxSize,
			MaxBackups: cfg.Board.Log.File.MaxBackups,
			MaxAge:     cfg.Board.Log.File.MaxAge,
			Compress:   cfg.Board.Log.File.Compress,
		},
	})
	slog.Info("app-content starting",
		"board_port", cfg.Board.Server.Port,
		"note_port", cfg.Note.Server.Port,
		"quiz_port", cfg.Quiz.Server.Port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup
	errCh := make(chan error, 3)
	start := func(name string, run func(context.Context) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := run(ctx); err != nil {
				select {
				case errCh <- fmt.Errorf("%s: %w", name, err):
				default:
				}
			}
		}()
	}
	start("board", func(ctx context.Context) error { return board.Run(ctx, &cfg.Board) })
	start("note", func(ctx context.Context) error { return note.Run(ctx, &cfg.Note) })
	start("quiz", func(ctx context.Context) error { return quiz.Run(ctx, &cfg.Quiz) })

	var runErr error
	select {
	case <-ctx.Done():
		slog.Info("app-content shutting down")
	case err := <-errCh:
		runErr = err
		stop()
	}
	wg.Wait()
	if runErr != nil {
		fatal("run", runErr)
	}
	slog.Info("app-content stopped")
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "app-content: %s: %v\n", msg, err)
	os.Exit(1)
}
