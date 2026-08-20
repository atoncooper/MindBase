// app-task entrypoint: load config, init DB, start scheduler + Gin HTTP server,
// graceful shutdown. Pure scheduler: dispatch tasks to third-party executors,
// record outcomes. Run from project root: go run ./app-task
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

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/logger"
	"app-task/internal/repo"
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

	// Validate critical config: fail loud instead of silently broken.
	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}
	// MySQL (GORM) - app-task's own independent instance; schema is created
	// via db.Migrate below (not shared with the main app).
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns, cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
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
	httpExec, err := executor.NewHTTPExecutor(executor.HTTPOptions{
		Timeout:            time.Duration(cfg.HTTPExecutor.TimeoutSeconds) * time.Second,
		InsecureSkipVerify: cfg.HTTPExecutor.InsecureSkipVerify,
		CAFile:             cfg.HTTPExecutor.CAFile,
	})
	if err != nil {
		slog.Error("init http executor", "err", err)
		os.Exit(1)
	}
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

	// Scheduler (DB-polling): dispatch due tasks + record outcomes in task_log.
	sched := service.NewScheduler(reg, cfg.Scheduler.IntervalSeconds)
	sched.Start()
	defer sched.Stop()

	// Mail delivery worker (queue + retries).
	emailSvc.Start()
	defer emailSvc.Stop()

	// HTTP server (Gin)
	handler := router.New(taskSvc, emailSvc, luaExec, cfg)
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
