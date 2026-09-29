package cli

// Server mode: `at` (no args) or `at serve` — the original app-task entrypoint
// (scheduler + API + console), moved here verbatim from main.go so one binary
// serves both roles.

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-task/internal/certgen"
	"app-task/internal/cluster"
	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/logger"
	"app-task/internal/repo"
	"app-task/internal/router"
	"app-task/internal/service"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

func newServeCmd(defaultYAML []byte) *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "启动 app-task 服务（调度器 + API + 控制台）",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServer(defaultYAML)
		},
	}
}

func runServer(defaultYAML []byte) error {
	cfg, err := config.Load(defaultYAML)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
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

	// Validate critical config: fail loud instead of silently broken.
	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}
	// MySQL (GORM) - app-task's own independent instance; schema is created
	// via db.Migrate below (not shared with the main app).
	if err := db.Init(db.Options{
		DSN:                cfg.RDBMS.URL,
		MaxOpenConns:       cfg.RDBMS.MaxOpenConns,
		MaxIdleConns:       cfg.RDBMS.MaxIdleConns,
		ConnMaxLifetimeSec: cfg.RDBMS.ConnMaxLifetime,
		ConnMaxIdleTimeSec: cfg.RDBMS.ConnMaxIdleTime,
		DialTimeoutSec:     cfg.RDBMS.DialTimeoutSeconds,
		ReadTimeoutSec:     cfg.RDBMS.ReadTimeoutSeconds,
		WriteTimeoutSec:    cfg.RDBMS.WriteTimeoutSeconds,
		TLS:                cfg.RDBMS.TLS,
		PrepareStmt:        cfg.RDBMS.PrepareStmt,
		SlowThresholdMS:    cfg.RDBMS.SlowThresholdMS,
		Debug:              cfg.App.Debug,
	}); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Create the app-task owned schema (task/task_log/script tables + indexes).
	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	// Seed the default webui admin account on first boot so the console is
	// always login-gated (username/password auth, see repo/user.go).
	if err := repo.EnsureDefaultAdmin(); err != nil {
		slog.Error("seed default webui admin failed", "err", err)
		os.Exit(1)
	}

	// Business timezone: cron expressions are interpreted in time.Local, so
	// pin it to the configured timezone (Asia/Shanghai) before parsing any
	// schedules. Storage stays UTC-aware; this only affects cron semantics.
	if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", err)
	}

	// Services: app-task is a pure scheduler — task registration + completion
	// callbacks, plus a mail-delivery platform capability (executors post
	// standardized emails, app-task queues + delivers with retries).
	taskSvc := service.NewTaskService()
	emailSvc := service.NewEmailService(cfg)

	// HTTP executor: dispatches tasks to third-party executors (the default
	// task_type). Supports http:// and https:// (private CA via ca_file,
	// self-signed via insecure_skip_verify). Lua: optional built-in executor.
	// CA 文件惰性加载（首次派发时读取），构造期不做 IO。
	httpExec := executor.NewHTTPExecutor(executor.HTTPOptions{
		Timeout:            time.Duration(cfg.HTTPExecutor.TimeoutSeconds) * time.Second,
		InsecureSkipVerify: cfg.HTTPExecutor.InsecureSkipVerify,
		CAFile:             cfg.HTTPExecutor.CAFile,
	})
	luaExec := executor.NewLuaExecutor(executor.LuaOptions{
		Timeout:      time.Duration(cfg.Lua.TimeoutSeconds) * time.Second,
		MaxIdleVM:    cfg.Lua.MaxIdleVM,
		MaxSourceLen: cfg.Lua.MaxSourceLen,
		HTTPTimeout:  time.Duration(cfg.Lua.HTTPTimeoutSeconds) * time.Second,
	})

	// Executor registry: task_type -> handler. http is the default; lua is the
	// optional built-in.
	reg := executor.NewRegistry()
	reg.Register("http", httpExec.Handler())
	reg.Register("lua", luaExec.Handler())

	// Cluster identity: one node id shared by the scheduler owner and the
	// cluster roster (task.owner / cluster_node.node_id are the same value).
	instanceID := cfg.Scheduler.InstanceID
	if instanceID == "" {
		host, _ := os.Hostname()
		instanceID = host + "-" + uuid.NewString()[:8]
	}

	// Cluster roster: heartbeats prove liveness; dead nodes' in-flight claims
	// are taken over by the scheduler immediately (fencing keeps this safe).
	clusterMgr := cluster.NewManager(cluster.Options{
		NodeID:    instanceID,
		Version:   router.Version,
		Weight:    cfg.Scheduler.Weight,
		Admission: cfg.Cluster.Admission,
	})
	if err := clusterMgr.Start(); err != nil {
		// Fail closed: in pre_approved admission a missing pre-registration
		// (join via the console cluster page or `at node join`) must never be
		// bypassed by a silently running scheduler.
		slog.Error("cluster registration failed", "err", err)
		os.Exit(1)
	}
	defer clusterMgr.Stop()

	// Scheduler (DB-polling): claim + dispatch due tasks in a bounded worker
	// pool, record outcomes in task_log. Zero option values fall back to the
	// service defaults.
	sched := service.NewScheduler(reg, service.SchedulerOptions{
		Interval:       time.Duration(cfg.Scheduler.IntervalSeconds) * time.Second,
		Workers:        cfg.Scheduler.Workers,
		BatchSize:      cfg.Scheduler.BatchSize,
		DispatchingTTL: time.Duration(cfg.Scheduler.DispatchingTimeoutSecond) * time.Second,
		PerURLLimit:    cfg.Scheduler.PerURLLimit,
		Owner:          instanceID,
		Weight:         cfg.Scheduler.Weight,
	})
	sched.SetClusterView(clusterMgr)
	sched.Start()
	defer sched.Stop()

	// Mail delivery worker (queue + retries).
	emailSvc.Start()
	defer emailSvc.Stop()

	// HTTP(S) server (Gin). TLS optional (server.tls): enabled -> the whole
	// service is served over HTTPS with a resolved certificate (explicit
	// cert/key pair, or an auto-generated self-signed dev certificate with
	// daily rotation checks, see internal/certgen).
	handler := router.New(taskSvc, emailSvc, luaExec, cfg)
	router.SetSchedulerStats(sched.Stats)
	router.SetClusterManager(clusterMgr)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	scheme := "http"
	serve := func() error { return srv.ListenAndServe() }
	if cfg.Server.TLS.Enabled {
		rot, err := certgen.NewRotator(cfg.Server.TLS.Cert, cfg.Server.TLS.Key, cfg.Server.TLS.CertDir)
		if err != nil {
			slog.Error("tls certificate setup failed", "err", err)
			os.Exit(1)
		}
		autoGenerated := cfg.Server.TLS.Cert == "" && cfg.Server.TLS.Key == ""
		slog.Info("[TLS] certificate ready", "cert", rot.CertPath(), "auto_generated", autoGenerated)
		stopRotator := make(chan struct{})
		defer close(stopRotator)
		rot.Start(stopRotator)
		srv.TLSConfig = &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: rot.GetCertificate,
		}
		scheme = "https"
		serve = func() error { return srv.ListenAndServeTLS("", "") }
	}

	go func() {
		slog.Info("app-task listening", "addr", addr, "scheme", scheme)
		if err := serve(); err != nil && err != http.ErrServerClosed {
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
	return nil
}
