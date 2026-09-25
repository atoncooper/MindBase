// app-cloud entrypoint: load config, init MySQL + MinIO + Mongo + Redis,
// start the trash sweeper and the Gin HTTP server, graceful shutdown.
//
// Cloud drive service: chunked uploads, folders, storage quotas, sharing,
// trash, and the Go-native document pipeline. Run from project root:
// go run ./app-go/app-cloud
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

	"app-cloud/internal/config"
	"app-cloud/internal/db"
	"app-cloud/internal/logger"
	"app-cloud/internal/minio"
	"app-cloud/internal/model"
	"app-cloud/internal/mongostore"
	pipelinepkg "app-cloud/internal/pipeline"
	"app-cloud/internal/repo"
	"app-cloud/internal/router"
	"app-cloud/internal/service"

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
	slog.Info("app-cloud starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

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

	// MinIO — same bucket/keys as the Python backend (zero data migration).
	mc, err := minio.New(&cfg.Minio)
	if err != nil {
		slog.Error("init minio failed", "err", err)
		os.Exit(1)
	}
	ctx := context.Background()
	if err := mc.EnsureBucket(ctx); err != nil {
		slog.Error("ensure bucket failed", "err", err)
		os.Exit(1)
	}
	slog.Info("[MINIO] init OK", "bucket", cfg.Minio.Bucket)

	// Redis (upload sessions/heartbeats + sweeper limiter).
	var rdb redis.UniversalClient
	if strings.TrimSpace(cfg.Redis.URL) != "" {
		if opts, perr := redis.ParseURL(cfg.Redis.URL); perr == nil {
			client := redis.NewClient(opts)
			pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			if perr := client.Ping(pingCtx).Err(); perr != nil {
				slog.Warn("[REDIS] unavailable at boot — upload sessions disabled until it recovers", "err", perr)
			} else {
				rdb = client
			}
			cancel()
		}
	}

	// Mongo (parsed documents + ASR previews; optional at boot).
	mongoStore, err := mongostore.NewMongoStore(ctx, cfg)
	if err != nil {
		slog.Warn("[MONGO] unavailable at boot — previews degrade gracefully", "err", err)
		mongoStore = &mongostore.MongoStore{}
	}
	defer mongoStore.Close(ctx)

	// Services.
	pending := service.NewPendingUploads(rdb, cfg.Upload.UploadMetaTTL)
	quotaSvc := service.NewQuotaService(cfg, db.DB, pending)
	uploadSvc := service.NewUploadService(cfg, db.DB, mc, rdb, quotaSvc, pending)
	reconciler := service.NewReconciler(db.DB, mc)
	pipe := service.NewPipeline(db.DB, mongoStore, redisPublisher{rdb}, cfg.WSBridge.Channel)
	// Engine: extractors → chunk → embed (Higress) → Milvus cloud_drive.
	if cfg.Pipeline.Enabled && cfg.Pipeline.Milvus.Enabled && strings.TrimSpace(cfg.Pipeline.Milvus.URI) != "" {
		milvusStore, merr := pipelinepkg.NewMilvusStore(ctx, cfg.Pipeline.Milvus, cfg.Pipeline.Embedding.Dimension)
		if merr != nil {
			slog.Error("milvus schema guard / connect failed — refusing degraded vector writes", "err", merr)
			os.Exit(1)
		}
		engine := pipelinepkg.NewEngine(db.DB, mc, mongoStore, milvusStore,
			pipelinepkg.NewEmbedder(cfg.Pipeline.Embedding), cfg.Pipeline.MaxDocSize)
		pipe.SetEngine(engine)
		slog.Info("[PIPELINE] vector engine attached", "collection", cfg.Pipeline.Milvus.Collection,
			"model", cfg.Pipeline.Embedding.Model, "dim", cfg.Pipeline.Embedding.Dimension)
	} else {
		slog.Warn("[PIPELINE] disabled — uploads will be marked not_supported for vectorization")
	}
	uploadSvc.SetCompletionHook(func(uploadUUID string, uid int64, file *model.CloudFile) {
		if !cfg.Pipeline.Enabled {
			return
		}
		go func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("[CLOUD_PIPELINE] panic", "upload_uuid", uploadUUID, "panic", r)
				}
			}()
			_, _ = pipe.RunSync(context.Background(), file)
		}()
	})
	purgeSvc := service.NewPurgeService(db.DB, mc, mongoStore, pipe)
	shareSvc := service.NewShareService(db.DB, mc, cfg.Minio.PresignExpire)

	// Trash sweeper: physically purge soft-deleted files after N days.
	// Reconciler: per-uid drift check (active users, rotating — never a
	// bucket-wide scan); runs on the same stop channel.
	sweeperStop := make(chan struct{})
	go runTrashSweeper(cfg, purgeSvc, sweeperStop)
	go runDailyReconciler(reconciler, sweeperStop)
	defer close(sweeperStop)

	// Business timezone.
	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	handler := router.New(router.Deps{
		Reconciler: reconciler,
		Cfg:        cfg,
		DB:         db.DB,
		Minio:      mc,
		Quota:      quotaSvc,
		Upload:     uploadSvc,
		Process:    pipe,
		Purge:      purgeSvc,
		Mongo:      mongoStore,
		Files:      repo.NewFileRepo(),
		Folders:    repo.NewFolderRepo(),
		Share:      shareSvc,
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-cloud listening", "addr", addr)
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
	slog.Info("app-cloud stopped")
}

// runDailyReconciler reconciles recently-active users once a day (bounded
// batch). Drift is logged; the DB ledger stays authoritative for quota.
func runDailyReconciler(rec *service.Reconciler, stop chan struct{}) {
	run := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		n := rec.ReconcileActiveUsers(ctx, 7, 50)
		if n > 0 {
			slog.Info("[RECONCILE] daily sweep done", "users", n)
		}
	}
	run() // catch up at boot
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			run()
		}
	}
}

// redisPublisher adapts go-redis to the service.RedisPublisher interface.
type redisPublisher struct{ c redis.UniversalClient }

func (p redisPublisher) Publish(ctx context.Context, channel string, message any) error {
	return p.c.Publish(ctx, channel, message).Err()
}

// runTrashSweeper periodically purges soft-deleted files older than the
// configured retention. One sweep tick is a no-op when nothing is eligible.
func runTrashSweeper(cfg *config.Config, purge *service.PurgeService, stop chan struct{}) {
	interval := time.Duration(cfg.Trash.SweepIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = time.Hour
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			olderThan := time.Now().AddDate(0, 0, -cfg.Trash.PurgeAfterDays)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			n, err := purge.PurgeExpired(ctx, olderThan, 500)
			cancel()
			if err != nil {
				slog.Warn("[TRASH_SWEEPER] sweep failed", "err", err)
			} else if n > 0 {
				slog.Info("[TRASH_SWEEPER] purged", "count", n)
			}
		}
	}
}
