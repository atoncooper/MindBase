// app-auth entrypoint: load config, init MySQL + Redis-backed token cache,
// seed RBAC roles, start the Gin HTTP server, graceful shutdown.
//
// Identity & access service for the MindBase stack: session tokens, login
// methods, account management, RBAC. Run from project root:
// go run ./app-go/app-auth
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

	"app-auth/internal/cache"
	"app-auth/internal/config"
	"app-auth/internal/db"
	"app-auth/internal/logger"
	"app-auth/internal/router"
	"app-auth/internal/security"
	"app-auth/internal/service"

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
	slog.Info("app-auth starting", "port", cfg.Server.Port, "tz", cfg.Timezone)

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

	// Encryption must be initialized before any token/oauth write; in
	// production an absent key is refused (parity with the Python startup
	// check assert_encryption_enabled).
	cipher, err := security.NewCipher(cfg.Security.APIKeyEncryptionKey)
	if err != nil {
		slog.Error("init aes cipher failed", "err", err)
		os.Exit(1)
	}
	if !cipher.Enabled() {
		slog.Warn("[AUTH_SECURITY] encryption key not set — DEV mode plaintext fallback active. DO NOT use in production.")
	}

	// Cache: hot-path token→uid (L1 memory, optional L2 Redis).
	tokCache, err := cache.New(cfg.Redis.URL, cfg.Auth.TokenCacheNS,
		time.Duration(cfg.Auth.CacheTTLSeconds)*time.Second)
	if err != nil {
		slog.Error("init token cache failed", "err", err)
		os.Exit(1)
	}
	defer tokCache.Close()

	// Schema: create-if-missing only, never ALTER (see db package docs).
	if err := db.Migrate(); err != nil {
		slog.Error("db migrate failed", "err", err)
		os.Exit(1)
	}

	// Services.
	snow, err := security.NewSnowflake(cfg.WorkerID)
	if err != nil {
		slog.Error("init snowflake failed", "err", err)
		os.Exit(1)
	}
	tokenSvc := service.NewTokenService(db.DB, cfg.Auth.TokenTTLDays, tokCache)
	rbacSvc := service.NewRBACService(db.DB)
	if err := rbacSvc.SeedDefaults(); err != nil {
		slog.Error("seed rbac defaults failed", "err", err)
		os.Exit(1)
	}
	authSvc := service.NewAuthService(db.DB, cfg, cipher, snow, tokenSvc, rbacSvc)

	// Redis-backed guards (all fail-open on Redis outage, WeChat state is
	// the fail-closed exception). rdb is nil when no URL is configured.
	var rdb redis.UniversalClient
	if strings.TrimSpace(cfg.Redis.URL) != "" {
		if opts, err := redis.ParseURL(cfg.Redis.URL); err == nil {
			client := redis.NewClient(opts)
			pingCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if err := client.Ping(pingCtx).Err(); err != nil {
				slog.Warn("[REDIS] unavailable at boot — captcha/throttle/limit run degraded", "err", err)
			} else {
				rdb = client
			}
			cancel()
		} else {
			slog.Warn("[REDIS] invalid url — running without Redis", "err", err)
		}
	}

	captchaSvc := service.NewCaptchaService(cfg, rdb)
	throttle := service.NewLoginThrottle(rdb)
	ipGuard := service.NewFixedWindowLimiter(rdb, "mind-base:rl:auth:")
	rateLimits := service.NewRateLimits(rdb, cfg.Security.RateLimit)
	wechatSvc := service.NewWeChatService(cfg, rdb)
	verification := service.NewVerification(cfg,
		service.NewEmailService(cfg), service.NewSMSService(cfg), authSvc)
	passport := service.NewBilibiliPassport()

	// Business timezone (parity with app-task; storage stays UTC-aware).
	if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", err)
	}

	handler := router.New(router.Deps{
		Cfg:          cfg,
		Tokens:       tokenSvc,
		Auth:         authSvc,
		RBAC:         rbacSvc,
		Verification: verification,
		Captcha:      captchaSvc,
		Throttle:     throttle,
		IPGuard:      ipGuard,
		RateLimits:   rateLimits,
		WeChat:       wechatSvc,
		Passport:     passport,
	})
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	go func() {
		slog.Info("app-auth listening", "addr", addr)
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
	slog.Info("app-auth stopped")
}
