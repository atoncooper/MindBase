// app-admin entrypoint: load config, init the shared bilirag MySQL, run the
// owned-table Migrate (admin_user / admin_session / admin_audit ONLY — the
// guard test in internal/db pins this), seed the default console admin
// account, optionally open the SECOND app_pay connection (payment console),
// serve /health + /api/* on 8016, graceful shutdown.
//
// Unified admin console: share moderation + payment operations
// (orders / memberships / entitlement events / SKU / compensation grant /
// refund review) + console account management. The former standalone
// app-pay-admin service is retired into this one. Runs on 127.0.0.1 loopback
// only in compose (no APISIX / no nginx).
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
	"strings"
	"syscall"
	"time"

	_ "time/tzdata" // embed IANA tz database so Asia/Shanghai works in distroless

	"app-admin/internal/cloud"
	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/logger"
	"app-admin/internal/payops"
	"app-admin/internal/repo"
	"app-admin/internal/router"
	"app-admin/internal/sandbox"
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
	// Optional sandbox console proxy: half-configured = warn + disable
	// (/api/sandbox/* answers 503); the rest of the console is unaffected.
	if config.NormalizeSandboxAdmin(cfg) {
		slog.Warn("[SANDBOX_ADMIN] base_url/token half-configured — sandbox console proxy DISABLED " +
			"(set both APPADMIN__SANDBOX_ADMIN__BASE_URL and APPADMIN__SANDBOX_ADMIN__TOKEN)")
	}
	// Optional refund-review workbench: half-configured = warn + hide the whole
	// group (404); never block the console over an optional payment feature.
	if config.NormalizePayOps(cfg) {
		slog.Warn("[PAY_OPS] base_url/key half-configured — refund review DISABLED " +
			"(set both APPADMIN__PAY__OPS__BASE_URL and APPADMIN__PAY__OPS__KEY)")
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

	// Payment operations (optional SECOND database: app_pay on app-pay-mysql).
	// The pay_* schema is Java-owned (Flyway): open the connection, never
	// migrate it. A failure degrades to "payment console disabled" (503 on
	// /api/pay/**) instead of taking the whole admin console down.
	var (
		payQuery  *service.PayQueryService
		payGrants *service.PayGrantService
		payOps    *payops.Client
		payAudit  *service.PayAudit
	)
	if payURL := strings.TrimSpace(cfg.PayRDBMS.URL); payURL != "" {
		if err := db.PayInit(payURL, cfg.PayRDBMS.MaxOpenConns, cfg.PayRDBMS.MaxIdleConns,
			cfg.PayRDBMS.ConnMaxLifetime, cfg.App.Debug); err != nil {
			slog.Error("[PAY] pay database unavailable — payment console DISABLED", "err", err)
		} else {
			defer db.PayClose()
			// Fund-operation JSONL trail (SHA-256 hash chain, 365d retention).
			payAudit = service.NewPayAudit(cfg.Pay.AuditFile)
			defer payAudit.Close()
			payQuery = service.NewPayQueryService()
			payGrants = service.NewPayGrantService(payAudit, service.GrantCaps{
				DailyMaxCount: cfg.Pay.Grant.DailyMaxCount,
				DailyMaxDays:  cfg.Pay.Grant.DailyMaxDays,
			})
			payOps = payops.New(cfg.Pay.Ops.BaseURL, cfg.Pay.Ops.Key, cfg.Pay.Ops.TimeoutSeconds)
			slog.Info("[PAY] payment console enabled",
				"grant_daily_max_count", cfg.Pay.Grant.DailyMaxCount,
				"grant_daily_max_days", cfg.Pay.Grant.DailyMaxDays,
				"refund_review", payOps.Enabled() && cfg.Pay.Ops.RefundReviewEnabled)
		}
	} else {
		slog.Info("[PAY] payment console disabled — APPADMIN__PAY_RDBMS__URL not set")
	}

	// Services: auth (session + login throttle), read-only queries, moderation,
	// and the app-cloud review client (nil unless fully wired — preview off).
	review := cloud.NewClient(cfg.CloudReview.BaseURL, cfg.CloudReview.Token)
	if !review.Enabled() {
		slog.Info("[CLOUD_REVIEW] preview disabled — APPADMIN__CLOUD_REVIEW__BASE_URL/TOKEN not both set")
	}
	// Sandbox console proxy client: unwired → every /api/sandbox/*
	// route answers 503 with {"detail":"sandbox 管理未配置"}; nothing else changes.
	sandboxAdmin := sandbox.NewClient(cfg.SandboxAdmin.BaseURL, cfg.SandboxAdmin.Token)
	if !sandboxAdmin.Enabled() {
		slog.Info("[SANDBOX_ADMIN] console proxy disabled — APPADMIN__SANDBOX_ADMIN__BASE_URL/TOKEN not both set")
	}
	// Login budgets: short per-IP window + longer per-account window, both
	// configured under security.login (zero values fall back to the defaults).
	slog.Info("[SECURITY] session binding",
		"device", cfg.Session.DeviceBindingMode(),
		"ip", cfg.Session.IPBindingMode(),
		"ipv4_prefix", cfg.Session.IPv4PrefixOr(),
		"ipv6_prefix", cfg.Session.IPv6PrefixOr(),
		"trusted_proxies", len(cfg.Security.TrustedProxies))
	auth := service.NewAuthServiceWithLimits(cfg.Session.TTLMinutes, service.LoginLimits{
		IPMax:                cfg.Security.Login.MaxFailsPerIP,
		IPWindowSeconds:      cfg.Security.Login.IPWindowSeconds,
		AccountMax:           cfg.Security.Login.MaxFailsPerAccount,
		AccountWindowSeconds: cfg.Security.Login.AccountWindowSeconds,
	})
	users := service.NewUserService()
	shares := service.NewShareService(review)
	audits := service.NewAuditService()
	sandboxSvc := service.NewSandboxService(sandboxAdmin)
	// Console account management (admin_user) is independent of the payment
	// database and therefore always wired.
	consoleUsers := service.NewConsoleUserService()

	handler := router.New(cfg, router.Deps{
		Auth:     auth,
		Users:    users,
		Shares:   shares,
		Audits:   audits,
		Sandbox:  sandboxSvc,
		Pay:      payQuery,
		Grants:   payGrants,
		Console:  consoleUsers,
		Ops:      payOps,
		PayAudit: payAudit,
	})
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
