// app-quiz entrypoint: load config, init MySQL + Mongo + Redis, ensure
// indexes, start the Gin HTTP server, graceful shutdown.
//
// Quiz storage service: history, wrong-answer notebook, export, detail,
// delete and sharing for quiz sets. The AI-bearing flows (generate /
// submit+grade) stay in the Python backend. Run from project root:
// go run ./app-go/app-quiz
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

	"app-quiz/internal/config"
	"app-quiz/internal/db"
	"app-quiz/internal/logger"
	"app-quiz/internal/mongostore"
	"app-quiz/internal/redisstore"
	"app-quiz/internal/router"
	"app-quiz/internal/service"
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
	slog.Info("app-quiz starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

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

	// Mongo — quiz question content (optional at boot; reads degrade to
	// empty results, same as the Python backend with Mongo disabled).
	ctx := context.Background()
	mongoStore, err := mongostore.NewMongoStore(ctx, cfg)
	if err != nil {
		slog.Warn("[MONGO] unavailable at boot — question reads degrade until it recovers", "err", err)
		mongoStore = &mongostore.MongoStore{}
	}
	defer mongoStore.Close(ctx)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure indexes failed (continuing — indexes may already exist)", "err", err)
	}

	// Redis — share L2 cache (optional at boot; every operation fails open
	// to the source stores).
	redisStore, err := redisstore.New(ctx, cfg)
	if err != nil {
		slog.Warn("[REDIS] unavailable at boot — share cache disabled until it recovers", "err", err)
		redisStore = &redisstore.Store{}
	}
	defer redisStore.Close()

	// Business timezone.
	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	quizSvc := service.New(db.DB, mongoStore.Database(), redisStore)
	// Daily quiz quota (shared Redis keys with the Python backend's
	// quiz_quota.py; fail-open when Redis is unavailable).
	quizSvc.Quota = redisStore
	quizSvc.QuotaLimits = map[string]int{"generate": cfg.Quota.Generate, "grade": cfg.Quota.Grade}
	handler := router.New(router.Deps{
		Cfg:  cfg,
		DB:   db.DB,
		Quiz: quizSvc,
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-quiz listening", "addr", addr)
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
	slog.Info("app-quiz stopped")
}
