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
	"app-cloud/internal/infra/db"
	"app-cloud/internal/infra/milvusstore"
	"app-cloud/internal/infra/minio"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/joblock"
	"app-cloud/internal/logger"
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

	// Redis (upload sessions/heartbeats, pending-quota ledger, and the
	// background-job lease — see internal/joblock).
	var rdb redis.UniversalClient
	if strings.TrimSpace(cfg.Redis.URL) == "" {
		slog.Warn("[REDIS] url not configured — upload sessions disabled and background jobs run WITHOUT the multi-replica lease (single-replica only)")
	} else if opts, perr := redis.ParseURL(cfg.Redis.URL); perr == nil {
		client := redis.NewClient(opts)
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		if perr := client.Ping(pingCtx).Err(); perr != nil {
			slog.Warn("[REDIS] unavailable at boot — upload sessions disabled and background jobs run WITHOUT the multi-replica lease until it recovers", "err", perr)
		} else {
			rdb = client
		}
		cancel()
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
	// L1 routing: summary generator + graph writer. Both best-effort — the
	// pipeline tolerates either being absent.
	docSummary := service.NewSummarizer(cfg.Pipeline.Summary, cfg.Pipeline.Embedding.APIKey, cfg.Pipeline.Embedding.BaseURL)
	kgClient := service.NewKgClient(cfg.Kg)
	pipe := service.NewPipeline(db.DB, mongoStore, redisPublisher{rdb}, cfg.WSBridge.Channel, quotaSvc,
		docSummary, kgClient, cfg.Pipeline.Admission.MaxPerUID, cfg.Pipeline.Admission.MaxQueueDepth)
	// Engine: extractors → chunk → embed (Higress) → Milvus cloud_drive.

	if cfg.Pipeline.Enabled && cfg.Pipeline.Milvus.Enabled && strings.TrimSpace(cfg.Pipeline.Milvus.URI) != "" {
		// Bounded dial: Milvus unreachable (e.g. storage profile not started)
		// must not hang boot forever — 10s then degrade, mirroring the
		// pipeline-disabled state. SCHEMA-SHAPE drift keeps the fail-loud
		// exit (a dim/field mismatch would silently poison retrieval).
		milvusCtx, milvusCancel := context.WithTimeout(ctx, 10*time.Second)
		milvusStore, merr := milvusstore.NewMilvusStore(milvusCtx, cfg.Pipeline.Milvus, cfg.Pipeline.Embedding.Dimension)
		milvusCancel()
		switch {
		case merr == nil:
			engine := pipelinepkg.NewEngine(db.DB, mc, mongoStore, milvusStore,
				pipelinepkg.NewEmbedder(cfg.Pipeline.Embedding), cfg.Pipeline.MaxDocSize)
			pipe.SetEngine(engine)
			slog.Info("[PIPELINE] vector engine attached", "collection", cfg.Pipeline.Milvus.Collection,
				"model", cfg.Pipeline.Embedding.Model, "dim", cfg.Pipeline.Embedding.Dimension)
		case strings.HasPrefix(merr.Error(), "MILVUS SCHEMA GUARD"):
			slog.Error("milvus schema guard failed — refusing degraded vector writes", "err", merr)
			os.Exit(1)
		default:
			slog.Error("[PIPELINE] milvus unreachable at boot — vectorization DEGRADED "+
				"(uploads will be marked not_supported; start the storage profile or set APPCLOUD__PIPELINE__ENABLED=false to silence)",
				"err", merr)
		}
	} else {
		slog.Warn("[PIPELINE] disabled — uploads will be marked not_supported for vectorization")
	}
	// Vectorization is USER-TRIGGERED ONLY (POST /cloud/video/{uuid}/process or
	// /reprocess): uploads must NOT auto-enqueue pipeline tasks.
	purgeSvc := service.NewPurgeService(db.DB, mc, mongoStore, pipe)
	purgeSvc.SetGraphWriter(kgClient)
	shareSvc := service.NewShareService(db.DB, mc, cfg.Minio.PresignExpire)
	// 1.0.16 — "save to my drive" references (ledger rows over the original
	// objects; reuses the share service's resolve + presign policy).
	refSvc := service.NewRefService(db.DB, shareSvc)
	// Attestation HMAC key — MUST be identical across replicas (P0-2 fix):
	// the share challenge/ticket chain is stateless and nginx round-robins
	// /cloud/s/*, so a per-process random key breaks cross-replica verification.
	// Invalid shapes were already rejected by config.Validate.
	attestKey, aerr := cfg.Attest.KeyBytes()
	if aerr != nil {
		slog.Error("invalid attest secret", "err", aerr)
		os.Exit(1)
	}
	attestor := service.NewDeviceAttestor(attestKey)

	// Bounded vectorize worker pool draining the cloud_vector_tasks outbox
	// (multi-replica safe: FOR UPDATE SKIP LOCKED claiming + stale requeue).
	pipe.StartWorkers(cfg.Pipeline.Workers, cfg.Pipeline.MaxWorkers, cfg.Pipeline.Autoscale)

	// Trash sweeper: physically purge soft-deleted files after N days.
	// Reconciler: per-uid drift check (active users, rotating — never a
	// bucket-wide scan); runs on the same stop channel.
	sweeperStop := make(chan struct{})
	go runTrashSweeper(cfg, purgeSvc, rdb, sweeperStop, jobLeaseTTL(cfg))
	go runDailyReconciler(reconciler, rdb, sweeperStop, jobLeaseTTL(cfg))
	defer pipe.StopWorkers(8 * time.Second)
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
		Ref:        refSvc,
		Attestor:   attestor,
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
// The Redis lease makes each run single-winner across replicas; reconcile is
// read-only reporting, so a rare duplicate boot-time catch-up is harmless.
// jobLeaseTTL — configured background-job lease TTL (see JoblockConfig for
// the sizing tradeoff between crash-recovery latency and rollout overlap).
func jobLeaseTTL(cfg *config.Config) time.Duration {
	return time.Duration(cfg.Joblock.LeaseTTLSecs) * time.Second
}

func runDailyReconciler(rec *service.Reconciler, rdb redis.UniversalClient, stop chan struct{}, leaseTTL time.Duration) {
	run := func() {
		lockCtx, lockCancel := context.WithTimeout(context.Background(), 5*time.Second)
		release, ok := joblock.TryAcquire(lockCtx, rdb, jobReconciler, leaseTTL)
		lockCancel()
		if !ok {
			slog.Info("[RECONCILE] lease held by another replica — skipping run")
			return
		}
		defer release()
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
// The Redis lease makes each tick single-winner across replicas: only the
// lock holder runs PurgeExpired, the rest of the fleet skips that round.
func runTrashSweeper(cfg *config.Config, purge *service.PurgeService, rdb redis.UniversalClient, stop chan struct{}, leaseTTL time.Duration) {
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
			lockCtx, lockCancel := context.WithTimeout(context.Background(), 5*time.Second)
			release, ok := joblock.TryAcquire(lockCtx, rdb, jobSweeper, leaseTTL)
			lockCancel()
			if !ok {
				slog.Info("[TRASH_SWEEPER] lease held by another replica — skipping tick")
				continue
			}
			olderThan := time.Now().AddDate(0, 0, -cfg.Trash.PurgeAfterDays)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			n, err := purge.PurgeExpired(ctx, olderThan, 500)
			cancel()
			release()
			if err != nil {
				slog.Warn("[TRASH_SWEEPER] sweep failed", "err", err)
			} else if n > 0 {
				slog.Info("[TRASH_SWEEPER] purged", "count", n)
			}
		}
	}
}

// Background-job names (internal/joblock). The lease TTL is configured
// (joblock.lease_ttl_seconds, default 900s): it comfortably exceeds the
// 10-minute job context — a finished run releases via compare-and-delete
// well before expiry, while a crashed holder frees the job for another
// replica within TTL.
const (
	jobSweeper    = "trash-sweeper"
	jobReconciler = "daily-reconciler"
)
