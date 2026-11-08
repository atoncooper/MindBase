// app-content entrypoint: the consolidated content-domain service. The three
// domains (board/note/quiz) share ONE Gin engine, ONE MySQL pool, ONE MongoDB
// client and ONE Redis client, served by ONE *http.Server (one process, one
// port); external paths, wire contracts, DB schemas and MCP protocols are
// unchanged.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"app-content/internal/bootstrap"
	"app-content/internal/config"
	"app-content/internal/logger"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fatal("load config", err)
	}

	logLevel := cfg.Log.Level
	if logLevel == "" {
		logLevel = "info"
	}
	if cfg.App.Debug && logLevel == "info" {
		logLevel = "debug"
	}
	// gin's mode is PROCESS-GLOBAL: set it exactly once here. Routers never
	// call gin.SetMode.
	if cfg.App.Debug {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	logger.Init(logger.Options{
		Level:     logLevel,
		Format:    cfg.Log.Format,
		Output:    cfg.Log.Output,
		AddSource: cfg.Log.AddSource,
		File: logger.FileOptions{
			Path:       cfg.Log.File.Path,
			MaxSize:    cfg.Log.File.MaxSize,
			MaxBackups: cfg.Log.File.MaxBackups,
			MaxAge:     cfg.Log.File.MaxAge,
			Compress:   cfg.Log.File.Compress,
		},
	})
	defer func() { _ = logger.Close() }()

	slog.Info("app-content starting",
		"port", cfg.Server.Port,
		"tls", cfg.Server.TLS.Enabled,
		"env", cfg.App.Env,
		"domains", "board,note,quiz")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := bootstrap.Run(ctx, cfg); err != nil {
		fatal("run", err)
	}
	slog.Info("app-content stopped")
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "app-content: %s: %v\n", msg, err)
	os.Exit(1)
}
