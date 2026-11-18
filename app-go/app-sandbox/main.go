// Command app-sandbox is the code-execution control plane: it owns sandbox
// leases, asynchronous executions, artifact metadata, daily quotas and the audit
// trail, and fronts a pluggable runtime (fake for tests/demos, opensandbox for
// the real OpenSandbox lifecycle server + execd).
//
// Run from the repository root:
//
//	go run ./app-go/app-sandbox
package main

import (
	"context"
	_ "embed" // embed default.yaml
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-sandbox/internal/config"
	"app-sandbox/internal/db"
	"app-sandbox/internal/logger"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/router"
	"app-sandbox/internal/runtime"
	"app-sandbox/internal/service"
)

//go:embed default.yaml
var defaultYAML []byte

func durationOr(ms int, fallback time.Duration) time.Duration {
	if ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return fallback
}

func main() {
	cfg, err := config.Load(defaultYAML)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}
	level := cfg.Log.Level
	if level == "" {
		level = "info"
	}
	if cfg.App.Debug && level == "info" {
		level = "debug"
	}
	logger.Init(logger.Options{
		Level:     level,
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
	slog.Info("app-sandbox starting", "port", cfg.Server.Port, "runtime", cfg.Runtime.Type, "tz", cfg.Timezone)

	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}
	if cfg.Auth.APIKey == "" {
		slog.Warn("[AUTH] auth.apiKey is empty: every /v1 and /internal request will be rejected (set SANDBOX__AUTH__API_KEY or APISIX_CONSUMER_KEY)")
	}

	if err := db.Init(cfg.Database.DSN, cfg.Database.MaxOpenConns, cfg.Database.MaxIdleConns,
		cfg.Database.ConnMaxLifetime, cfg.Database.ConnMaxIdleTime,
		cfg.Database.SlowThresholdMS, cfg.Database.PrepareStmt,
		cfg.Database.SkipDefaultTx, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	if loc, lerr := time.LoadLocation(cfg.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", lerr)
	}

	store := repo.NewMySQL(db.DB)
	m := metrics.New()
	// Live DB pool gauges for /metrics and alerting.
	m.AddGauge("sandbox_db_open_connections", nil, func() int64 { return int64(db.Stats().OpenConnections) })
	m.AddGauge("sandbox_db_in_use", nil, func() int64 { return int64(db.Stats().InUse) })
	m.AddGauge("sandbox_db_idle", nil, func() int64 { return int64(db.Stats().Idle) })
	m.AddGauge("sandbox_db_wait_count", nil, func() int64 { return db.Stats().WaitCount })
	m.AddGauge("sandbox_db_wait_duration_ms", nil, func() int64 { return db.Stats().WaitDuration.Milliseconds() })

	var rt runtime.Runtime
	switch cfg.Runtime.Type {
	case config.RuntimeOpenSandbox:
		rt = runtime.NewOpenSandbox(cfg.Runtime.OpenSandbox)
		slog.Info("[RUNTIME] opensandbox adapter enabled (payloads must be validated against the running OpenSandbox version)")
	default:
		rt = runtime.NewFake()
		slog.Warn("[RUNTIME] fake runtime enabled: executions return canned output, no isolation")
	}

	quota := service.NewQuotaService(cfg, store, m)
	leases := service.NewLeaseManager(cfg, rt, store, store, store, quota, m)
	admission := service.NewAdmission(cfg, m)
	m.AddGauge("sandbox_admission_memory_in_use", nil, func() int64 {
		inUse, _ := admission.MemoryStats()
		return inUse
	})
	m.AddGauge("sandbox_admission_memory_limit", nil, func() int64 {
		_, limit := admission.MemoryStats()
		return limit
	})
	var artifactStore service.ArtifactStore
	if cfg.Artifacts.Store == "minio" {
		minioStore, err := service.NewMinioArtifactStore(cfg, rt)
		if err != nil {
			slog.Error("init minio artifact store failed", "err", err)
			os.Exit(1)
		}
		artifactStore = minioStore
	} else {
		slog.Warn("[ARTIFACTS] fake store enabled: collected files will not be uploaded")
		artifactStore = service.NewFakeArtifactStore()
	}
	executions := service.NewExecutionService(service.ExecutionDeps{
		Config:        cfg,
		Executions:    store,
		Artifacts:     store,
		Usage:         store,
		Audit:         store,
		Leases:        leases,
		Quota:         quota,
		Admission:     admission,
		Runtime:       rt,
		ArtifactStore: artifactStore,
		Metrics:       m,
	})
	leases.SetCanceler(executions)
	files := service.NewFileService(leases, rt)
	sweeper := service.NewSweeper(cfg, store, leases, executions, store, rt, m)
	// Internal admin API: read-only queries over the sandbox_* tables
	// plus cancel/release delegating to the live services.
	admin := service.NewAdminService(service.AdminDeps{
		Config:       cfg,
		Leases:       store,
		Executions:   store,
		Artifacts:    store,
		Usage:        store,
		Audit:        store,
		Queries:      store,
		ExecService:  executions,
		LeaseManager: leases,
		Quota:        quota,
	})

	engine := router.New(router.Deps{
		Cfg:         cfg,
		Executions:  executions,
		Leases:      leases,
		Files:       files,
		Admin:       admin,
		Metrics:     m,
		RuntimeName: rt.Name(),
		PingDB: func(context.Context) error {
			return db.Ping()
		},
		RuntimeProbe: func(ctx context.Context) error {
			if prober, ok := rt.(runtime.Prober); ok {
				return prober.Probe(ctx)
			}
			return nil
		},
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           engine,
		ReadHeaderTimeout: durationOr(cfg.Server.ReadHeaderTimeoutMS, 10*time.Second),
		ReadTimeout:       durationOr(cfg.Server.ReadTimeoutMS, 30*time.Second),
		// 0 keeps SSE (/v1/executions/{id}/events) open; it is explicitly
		// configurable for non-streaming deployments.
		WriteTimeout: time.Duration(cfg.Server.WriteTimeoutMS) * time.Millisecond,
		IdleTimeout:  durationOr(cfg.Server.IdleTimeoutMS, 120*time.Second),
	}
	if cfg.Server.MaxHeaderBytes > 0 {
		srv.MaxHeaderBytes = cfg.Server.MaxHeaderBytes
	}
	slog.Info("http server configured",
		"addr", addr,
		"read_header_timeout_ms", cfg.Server.ReadHeaderTimeoutMS,
		"read_timeout_ms", cfg.Server.ReadTimeoutMS,
		"write_timeout_ms", cfg.Server.WriteTimeoutMS,
		"idle_timeout_ms", cfg.Server.IdleTimeoutMS,
		"max_header_bytes", srv.MaxHeaderBytes,
		"max_body_bytes", cfg.Server.MaxBodyBytes,
	)

	sweepCtx, stopSweeper := context.WithCancel(context.Background())
	defer stopSweeper()
	go sweeper.Run(sweepCtx)

	go func() {
		slog.Info("app-sandbox listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down")
	stopSweeper()
	shutdownCtx, cancel := context.WithTimeout(context.Background(),
		durationOr(cfg.Server.ShutdownTimeoutMS, 15*time.Second))
	defer cancel()
	srv.SetKeepAlivesEnabled(false)
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("http shutdown error", "err", err)
	}
	executions.Shutdown(shutdownCtx)
	slog.Info("app-sandbox stopped")
}
