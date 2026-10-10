// app-bili entrypoint: load config, init MySQL + Mongo + Redis, start the
// Gin HTTP server, graceful shutdown.
//
// Bilibili data acquisition service: favorites sync/organize, video info,
// audio/subtitle fetching, DashScope ASR transcription, and the knowledge
// build orchestration (sync + ASR; vectorization stays in the Python AI
// stack and is triggered via the bili:page_ready Redis event).
// Run from project root: go run ./app-go/app-bili
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

	"app-bili/internal/asr"
	"app-bili/internal/bili"
	"app-bili/internal/config"
	"app-bili/internal/db"
	"app-bili/internal/events"
	"app-bili/internal/logger"
	"app-bili/internal/mongostore"
	"app-bili/internal/repo"
	"app-bili/internal/router"
	"app-bili/internal/service"

	"github.com/redis/go-redis/v9"
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
	slog.Info("app-bili starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

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

	// Mongo — asr_documents (optional at boot; content writes fail loudly).
	ctx := context.Background()
	mongoStore, err := mongostore.NewMongoStore(ctx, cfg)
	if err != nil {
		slog.Warn("[MONGO] unavailable at boot — ASR writes will fail until it recovers", "err", err)
		mongoStore = &mongostore.MongoStore{}
	}
	defer mongoStore.Close(ctx)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure indexes failed (continuing — indexes may already exist)", "err", err)
	}

	// Redis — events (page_ready / task progress); optional (events dropped).
	var rdb redis.UniversalClient
	if strings.TrimSpace(cfg.Redis.URL) != "" {
		if opts, perr := redis.ParseURL(cfg.Redis.URL); perr == nil {
			client := redis.NewClient(opts)
			pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			if perr := client.Ping(pingCtx).Err(); perr != nil {
				slog.Warn("[REDIS] unavailable at boot — events will be dropped", "err", perr)
			} else {
				rdb = client
			}
			cancel()
		}
	}

	// Business timezone.
	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	resolver := bili.NewCredentialResolver(cfg, db.DB, rdb)
	publisher := events.NewPublisher(rdb)
	contentRepo := repo.NewASRContentRepo(mongoStore.Database())
	transcriber := asr.NewTranscriber(cfg)
	asrSvc := service.NewASRPageService(cfg, db.DB, contentRepo, transcriber, publisher, resolver)
	favSvc := service.NewFavoriteService(db.DB)
	buildSvc := service.NewBuildService(cfg, db.DB, favSvc, asrSvc, publisher, resolver)
	scopeSvc := service.NewKnowledgeScopeService(db.DB)
	pagesSvc := service.NewVideoPagesService(db.DB)

	handler := router.New(router.Deps{
		Cfg:      cfg,
		DB:       db.DB,
		Fav:      favSvc,
		ASR:      asrSvc,
		Build:    buildSvc,
		Scope:    scopeSvc,
		Pages:    pagesSvc,
		Resolver: resolver,
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-bili listening", "addr", addr)
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
	slog.Info("app-bili stopped")
}
