// app-task entrypoint: load config, init DB/Mongo, start scheduler + notification
// worker + Gin HTTP server, graceful shutdown. Run from project root: go run ./app-task
package main

import (
	"context"
	_ "embed" // embed default.yaml via //go:embed below
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/logger"
	"app-task/internal/mongo"
	"app-task/internal/router"
	"app-task/internal/service"
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
	slog.Info("app-task starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

	// Validate critical config: fail loud instead of silently broken (every
	// task would fail quiz requests; emails would dry-run as "sent").
	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}
	if cfg.Email.APIKey == "" {
		slog.Warn("EMAIL_API_KEY not set: emails will be marked dry_run (NOT sent); set APPTASK__EMAIL__API_KEY for real delivery")
	}
	if strings.Contains(cfg.Email.From, "onboarding@resend.dev") {
		slog.Warn("email.from_email uses Resend shared test domain: only delivers to the account owner; configure a verified domain for production", "from", cfg.Email.From)
	}
	slog.Info("mongo db_name in use (must match main app config.yaml mongo.db_name)", "db_name", cfg.Mongo.DBName)

	// MySQL (GORM) - shared with main app, task_quiz_* tables
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns, cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// MongoDB - shared with main app, task_quiz_questions collection
	if err := mongo.Init(cfg.Mongo.URI, cfg.Mongo.DBName, cfg.Mongo.ServerSelectionTimeoutMS); err != nil {
		slog.Error("init mongo failed", "err", err)
		os.Exit(1)
	}
	defer mongo.Close()

	// Services
	appClient := service.NewAppClient(cfg)
	taskSvc := service.NewTaskService(appClient)

	// Scheduler (DB-polling) + notification worker (email retry)
	sched := service.NewScheduler(taskSvc, cfg.Scheduler.IntervalSeconds)
	sched.Start()
	defer sched.Stop()

	worker := service.NewNotificationWorker(cfg)
	worker.Start()
	defer worker.Stop()

	// HTTP server (Gin)
	handler := router.New(taskSvc, cfg)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-task listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
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
	slog.Info("app-task stopped")
}
