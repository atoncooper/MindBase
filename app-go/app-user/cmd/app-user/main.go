// app-user entrypoint: the consolidated user-domain service. It hosts three
// independent Gin engines on the legacy ports, so external contracts are
// unchanged: 8006 = auth (+ forward-auth verify), 8010 = bili acquisition,
// 8015 = settings. The domains share one process, one MySQL connection, one
// logger and one image; they never import each other (see internal/contracts).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata"

	"app-user/internal/config"
	"app-user/internal/infra/cache"
	authdb "app-user/internal/infra/db/auth"
	authsecurity "app-user/internal/infra/security"
	authrouter "app-user/internal/router/auth"
	authservice "app-user/internal/service/auth"

	"app-user/internal/bili/asr"
	"app-user/internal/bili/bili"
	"app-user/internal/bili/events"
	bilidb "app-user/internal/infra/db/bili"
	"app-user/internal/infra/mongo"
	"app-user/internal/repo/bili"
	bilirouter "app-user/internal/router/bili"
	biliservice "app-user/internal/service/bili"
	settingsservice "app-user/internal/service/settings"

	"app-user/internal/contracts"
	settingsdb "app-user/internal/infra/db/settings"
	settingsminio "app-user/internal/infra/minio"
	appmysql "app-user/internal/infra/mysql"
	infraredis "app-user/internal/infra/redis"
	applogger "app-user/internal/logger"
	settingsrouter "app-user/internal/router/settings"
)

func main() {
	// ── config: each domain keeps its legacy env prefix (APPAUTH__/APPBILI__/
	// APPSETTINGS__) so compose/.env need no rename in this cutover. ──
	cfg, err := config.Load()
	if err != nil {
		fatal("load config", err)
	}
	if err := config.Validate(cfg); err != nil {
		fatal("validate config", err)
	}
	cfgAuth := &cfg.Auth
	cfgBili := &cfg.Bili
	cfgSettings := &cfg.Settings

	// ── logger: one process-wide slog handler (formerly three). ──
	logLevel := cfgAuth.Log.Level
	if logLevel == "" {
		logLevel = "info"
	}
	if cfgAuth.App.Debug && logLevel == "info" {
		logLevel = "debug"
	}
	applogger.Init(applogger.Options{
		Level:  logLevel,
		Format: cfgAuth.Log.Format,
		Output: cfgAuth.Log.Output,
		File: applogger.FileOptions{
			Path:       cfgAuth.Log.File.Path,
			MaxSize:    cfgAuth.Log.File.MaxSize,
			MaxBackups: cfgAuth.Log.File.MaxBackups,
			MaxAge:     cfgAuth.Log.File.MaxAge,
			Compress:   cfgAuth.Log.File.Compress,
		},
	})
	slog.Info("app-user starting",
		"auth_port", cfgAuth.Server.Port,
		"bili_port", cfgBili.Server.Port,
		"settings_port", cfgSettings.Server.Port,
		"tz", cfgAuth.Timezone)

	// ── MySQL: auth and bili keep separate pools on the same DSN (loc=UTC)
	// so heavy acquisition/ASR queries cannot starve the forward-auth hot path. ──
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	gdb, err := appmysql.Init(cfgAuth.RDBMS.URL,
		cfgAuth.RDBMS.MaxOpenConns, cfgAuth.RDBMS.MaxIdleConns,
		cfgAuth.RDBMS.ConnMaxLifetime, cfgAuth.App.Debug)
	if err != nil {
		fatal("init auth mysql", err)
	}
	defer func() { _ = appmysql.Close(gdb) }()

	biliDBURL := cfgBili.RDBMS.URL
	if biliDBURL == "" {
		biliDBURL = cfgAuth.RDBMS.URL
	}
	biliGDB, err := appmysql.Init(biliDBURL,
		cfgBili.RDBMS.MaxOpenConns, cfgBili.RDBMS.MaxIdleConns,
		cfgBili.RDBMS.ConnMaxLifetime, cfgBili.App.Debug)
	if err != nil {
		fatal("init bili mysql", err)
	}
	defer func() { _ = appmysql.Close(biliGDB) }()
	authdb.Use(gdb)
	bilidb.Use(biliGDB)
	settingsdb.Use(gdb)

	// ── schema: each domain keeps its CREATE-only migrator + guard tests. ──
	if err := authdb.Migrate(); err != nil {
		fatal("auth migrate", err)
	}
	if err := bilidb.Migrate(); err != nil {
		fatal("bili migrate", err)
	}
	if err := settingsdb.Migrate(); err != nil {
		fatal("settings migrate", err)
	}
	// Daily retention jobs (expired sessions/codes/attempts/tasks).
	startCleanup(bgCtx, gdb, biliGDB)

	// ── one shared Redis client for auth cache/limiters and bili events. ──
	sharedRedisURL := cfgAuth.Redis.URL
	if sharedRedisURL == "" {
		sharedRedisURL = cfgBili.Redis.URL
	}
	sharedRedis := infraredis.New(sharedRedisURL)
	if sharedRedis != nil {
		defer func() { _ = sharedRedis.Close() }()
	}

	// ── shared cipher (only the auth domain instantiates it now). ──
	cipher, err := authsecurity.NewCipher(cfgAuth.Security.APIKeyEncryptionKey)
	if err != nil {
		fatal("init aes cipher", err)
	}
	if !cipher.Enabled() {
		slog.Warn("[AUTH_SECURITY] encryption key not set - DEV mode plaintext fallback active. DO NOT use in production.")
	}

	// Auth-owned credential provider: bili consumes it via the contracts
	// interface. Its decrypted cache lives in this process, never in Redis.
	credentialProvider := authservice.NewBiliCredentialProvider(gdb, cipher)
	var _ contracts.BiliCredentialProvider = credentialProvider

	// ── auth domain (identity / forward-auth authority). ──
	tokCache := cache.New(sharedRedis, cfgAuth.Auth.TokenCacheNS,
		time.Duration(cfgAuth.Auth.CacheTTLSeconds)*time.Second)
	snow, err := authsecurity.NewSnowflake(cfgAuth.WorkerID)
	if err != nil {
		fatal("init snowflake", err)
	}
	tokenSvc := authservice.NewTokenService(gdb, cfgAuth.Auth.TokenTTLDays, tokCache)
	authzCache := cache.NewAuthz(sharedRedis, cfgAuth.Auth.TokenCacheNS, 60*time.Second)
	rbacSvc := authservice.NewRBACService(gdb)
	if err := rbacSvc.SeedDefaults(); err != nil {
		fatal("seed rbac defaults", err)
	}
	authSvc := authservice.NewAuthService(gdb, cfgAuth, cipher, snow, tokenSvc, rbacSvc, authzCache, credentialProvider.Invalidate)

	captchaSvc := authservice.NewCaptchaService(cfgAuth, sharedRedis)
	throttle := authservice.NewLoginThrottle(sharedRedis)
	ipGuard := authservice.NewFixedWindowLimiter(sharedRedis, "mind-base:rl:auth:")
	rateLimits := authservice.NewRateLimits(sharedRedis, cfgAuth.Security.RateLimit)
	wechatSvc := authservice.NewWeChatService(cfgAuth, sharedRedis)
	verification := authservice.NewVerification(cfgAuth,
		authservice.NewEmailService(cfgAuth), authservice.NewSMSService(cfgAuth), authSvc)
	passport := authservice.NewBilibiliPassport()

	authEngine := authrouter.New(authrouter.Deps{
		Cfg: cfgAuth,
		Health: func(ctx context.Context) error {
			return gdb.WithContext(ctx).Exec("select 1").Error
		},
		RedisHealth: func(ctx context.Context) error {
			if sharedRedis != nil {
				return sharedRedis.Ping(ctx).Err()
			}
			return nil
		},
		Tokens:       tokenSvc,
		Auth:         authSvc,
		RBAC:         rbacSvc,
		Verification: verification,
		Captcha:      captchaSvc,
		Attestor:     authservice.NewDeviceAttestor(),
		Throttle:     throttle,
		IPGuard:      ipGuard,
		RateLimits:   rateLimits,
		WeChat:       wechatSvc,
		Passport:     passport,
	})

	// ── bili domain (acquisition + ASR + build). Consumes the auth-owned
	// credential provider; it must not read user_oauth itself. ──
	ctx := context.Background()
	mongoStore, err := mongo.NewMongoStore(ctx, cfgBili)
	if err != nil {
		slog.Warn("[MONGO] unavailable at boot - ASR writes will fail until it recovers", "err", err)
		mongoStore = &mongo.MongoStore{}
	}
	defer mongoStore.Close(ctx)
	if err := mongoStore.EnsureIndexes(ctx); err != nil {
		slog.Warn("[MONGO] ensure indexes failed (continuing - indexes may already exist)", "err", err)
	}
	resolver := bili.NewCredentialResolver(cfgBili, credentialProvider)
	publisher := events.NewPublisher(sharedRedis)
	contentRepo := repo.NewASRContentRepo(mongoStore.Database())
	transcriber := asr.NewTranscriber(cfgBili)
	asrSvc := biliservice.NewASRPageService(cfgBili, biliGDB, contentRepo, transcriber, publisher, resolver)
	favSvc := biliservice.NewFavoriteService(biliGDB)
	buildSvc := biliservice.NewBuildService(cfgBili, biliGDB, favSvc, asrSvc, publisher, resolver)
	scopeSvc := biliservice.NewKnowledgeScopeService(biliGDB)
	pagesSvc := biliservice.NewVideoPagesService(biliGDB)
	biliEngine := bilirouter.New(bilirouter.Deps{
		Cfg: cfgBili,
		Health: func(ctx context.Context) error {
			return repo.Ping(ctx, biliGDB)
		},
		RedisHealth: func(ctx context.Context) error {
			if sharedRedis != nil {
				return sharedRedis.Ping(ctx).Err()
			}
			return nil
		},
		Fav:      favSvc,
		ASR:      asrSvc,
		Build:    buildSvc,
		Scope:    scopeSvc,
		Pages:    pagesSvc,
		Resolver: resolver,
	})

	// ── settings domain (preferences / avatar). ──
	minioStore, err := settingsminio.New(cfgSettings.MinIO.Endpoint, cfgSettings.MinIO.AccessKey,
		cfgSettings.MinIO.SecretKey, cfgSettings.MinIO.Bucket, cfgSettings.MinIO.Secure)
	if err != nil {
		slog.Warn("[MINIO] init failed, avatar upload disabled", "err", err)
		minioStore = nil
	}
	settingsrouter.SetMinioStore(minioStore)
	settingsSvc := settingsservice.New(gdb)
	settingsEngine := settingsrouter.New(settingsrouter.Deps{Cfg: cfgSettings, Svc: settingsSvc})

	// Business timezone (after DB init: DSN loc is pinned to UTC above).
	if loc, lerr := time.LoadLocation(cfgAuth.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfgAuth.Timezone, "err", lerr)
	}

	// ── three engines, three listeners: external paths/ports unchanged. ──
	servers := []*http.Server{
		{Addr: fmt.Sprintf("%s:%d", cfgAuth.Server.Host, cfgAuth.Server.Port), Handler: authEngine},
		{Addr: fmt.Sprintf("%s:%d", cfgBili.Server.Host, cfgBili.Server.Port), Handler: biliEngine},
		{Addr: fmt.Sprintf("%s:%d", cfgSettings.Server.Host, cfgSettings.Server.Port), Handler: settingsEngine},
	}
	scheme := "http"
	if cfg.TLS.CertFile != "" {
		scheme = "https"
	}
	for _, srv := range servers {
		s := srv
		go func() {
			slog.Info("app-user listening", "addr", s.Addr, "scheme", scheme)
			var err error
			if scheme == "https" {
				err = s.ListenAndServeTLS(cfg.TLS.CertFile, cfg.TLS.KeyFile)
			} else {
				err = s.ListenAndServe()
			}
			if err != nil && err != http.ErrServerClosed {
				fatal("http server stopped", err)
			}
		}()
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down app-user")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown error", "addr", srv.Addr, "err", err)
		}
	}
	slog.Info("app-user stopped")
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "app-user: %s: %v\n", msg, err)
	os.Exit(1)
}
