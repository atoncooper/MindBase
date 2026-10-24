// app-admin entrypoint: load config, init DB (shared bilirag MySQL), run the
// owned-table Migrate (admin_user / admin_session / admin_audit ONLY — the
// guard test in internal/db pins this), seed the default console admin
// account, serve /health + /api/* on 8016, graceful shutdown.
//
// Share-moderation admin console (plan/1.0.16): read-only view of users /
// shares metadata + the four moderation columns on cloud_shares. Runs on
// 127.0.0.1 loopback only in compose (no APISIX / no nginx), like
// app-pay-admin.
package main

import (
	"context"
	_ "embed" // embed default.yaml via //go:embed below
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-admin/internal/cloud"
	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/logger"
	"app-admin/internal/repo"
	"app-admin/internal/router"
	"app-admin/internal/service"
)

//go:embed default.yaml
var defaultYAML []byte

func main() {
	// Optional overlay config file (-config or a single positional argument),
	// same conventions as app-pay-admin. Empty = embedded defaults + env only.
	configFile := flag.String("config", "", "overlay config file merged over the embedded default.yaml")
	flag.Parse()
	overlayPath := *configFile
	if overlayPath == "" && flag.NArg() > 0 {
		overlayPath = flag.Arg(0)
	}

	cfg, err := config.Load(defaultYAML, overlayPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	// Logging (slog; level/format from log config, debug flag bumps info->debug).
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
	if overlayPath != "" {
		slog.Info("[CONFIG] overlay loaded", "file", overlayPath)
	}
	slog.Info("app-admin starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

	// Validate critical config: fail loud instead of silently broken.
	if err := config.Validate(cfg); err != nil {
		slog.Error("config validation failed", "err", err)
		os.Exit(1)
	}
	// Optional review-preview wiring: half-configured = warn + disable (never
	// block the console over an optional feature).
	if config.NormalizeCloudReview(cfg) {
		slog.Warn("[CLOUD_REVIEW] base_url/token half-configured — content preview DISABLED " +
			"(set both APPADMIN__CLOUD_REVIEW__BASE_URL and APPADMIN__CLOUD_REVIEW__TOKEN)")
	}

	// MySQL (GORM): the shared bilirag database. cloud_shares / users / rbac_*
	// rows are read or the four moderation columns are UPDATEd — db.Migrate
	// must only ever create the three admin_* own tables.
	if err := db.Init(cfg.RDBMS.URL, cfg.RDBMS.MaxOpenConns, cfg.RDBMS.MaxIdleConns, cfg.RDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
		slog.Error("init mysql failed", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	// Seed the default console admin account (missing username only) so the
	// console is login-gated from first boot; first login must change password.
	if err := repo.EnsureSeedAdmin(cfg.Seed.Username, cfg.Seed.Password); err != nil {
		slog.Error("seed default admin failed", "err", err)
		os.Exit(1)
	}

	// Business timezone: pinned to Asia/Shanghai like the whole Go fleet;
	// DSN loc=Local keeps DATETIME wall-clock semantics identical.
	if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", err)
	}

	// Services: auth (session + login throttle), read-only queries, moderation,
	// and the app-cloud review client (nil unless fully wired — preview off).
	review := cloud.NewClient(cfg.CloudReview.BaseURL, cfg.CloudReview.Token)
	if !review.Enabled() {
		slog.Info("[CLOUD_REVIEW] preview disabled — APPADMIN__CLOUD_REVIEW__BASE_URL/TOKEN not both set")
	}
	auth := service.NewAuthService(cfg.Session.TTLMinutes)
	users := service.NewUserService()
	shares := service.NewShareService(review)
	audits := service.NewAuditService()

	handler := router.New(cfg, auth, users, shares, audits)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-admin listening", "addr", addr)
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
	slog.Info("app-admin stopped")
}
