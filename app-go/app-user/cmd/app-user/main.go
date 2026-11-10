// app-user entrypoint: one process, one HTTP listener (8006). Auth, bili and
// settings are in-process Gin engines mounted behind a path dispatcher; there
// are no cross-domain HTTP calls and no separate listener ports.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	"app-user/internal/infra/httpserver"
	"app-user/internal/infra/mongo"
	"app-user/internal/repo/bili"
	bilirouter "app-user/internal/router/bili"
	biliservice "app-user/internal/service/bili"
	settingsservice "app-user/internal/service/settings"

	"app-user/internal/contracts"
	avatarcloud "app-user/internal/infra/cloud"
	settingsdb "app-user/internal/infra/db/settings"
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
			Path:              cfgAuth.Log.File.Path,
			MaxSize:           cfgAuth.Log.File.MaxSize,
			MaxBackups:        cfgAuth.Log.File.MaxBackups,
			MaxAge:            cfgAuth.Log.File.MaxAge,
			Compress:          cfgAuth.Log.File.Compress,
			CompressAlgorithm: cfgAuth.Log.File.CompressAlgorithm,
			CompressLevel:     cfgAuth.Log.File.CompressLevel,
			CompressQueue:     cfgAuth.Log.File.CompressQueue,
			MaxTotalSize:      cfgAuth.Log.File.MaxTotalSize,
		},
		AddSource:  cfgAuth.Log.AddSource,
		RedactKeys: cfgAuth.Log.RedactKeys,
		Sampling: applogger.SamplingOptions{
			Enabled:    cfgAuth.Log.Sampling.Enabled,
			Initial:    cfgAuth.Log.Sampling.Initial,
			Thereafter: cfgAuth.Log.Sampling.Thereafter,
		},
		Async: applogger.AsyncOptions{
			Enabled:      cfgAuth.Log.Async.Enabled,
			Buffer:       cfgAuth.Log.Async.Buffer,
			DropWhenFull: cfgAuth.Log.Async.DropWhenFull,
		},
	})
	defer applogger.Close()
	applogger.ConfigureAccessLog(cfgAuth.Server.AccessLogEnabled, cfgAuth.Server.AccessLogSampleRate, cfgAuth.Server.AccessLogFormat)
	slog.Info("app-user starting",
		"port", cfgAuth.Server.Port,
		"tz", cfgAuth.Timezone)

	// ── MySQL: auth and bili keep separate pools on the same DSN (loc=UTC)
	// so heavy acquisition/ASR queries cannot starve the forward-auth hot path. ──
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	gdb, err := appmysql.Init(cfgAuth.RDBMS.URL,
		cfgAuth.RDBMS.MaxOpenConns, cfgAuth.RDBMS.MaxIdleConns,
		cfgAuth.RDBMS.ConnMaxLifetime, cfgAuth.RDBMS.ConnMaxIdleTime, cfgAuth.App.Debug)
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
		cfgBili.RDBMS.ConnMaxLifetime, cfgBili.RDBMS.ConnMaxIdleTime, cfgBili.App.Debug)
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
	redisCfg := cfgAuth.Redis
	if redisCfg.URL == "" {
		redisCfg.URL = cfgBili.Redis.URL
	}
	sharedRedis := infraredis.New(redisCfg)
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

	// ── settings domain (preferences / avatar / Coding Plan). ──
	// Avatar objects live in app-cloud (MinIO owner); app-user only gets the
	// internal M2M client, so no MinIO credentials/dependency here.
	avatarClient := avatarcloud.NewAvatarClient(
		cfgSettings.AppCloud.BaseURL,
		cfgSettings.AppCloud.APIKey,
		time.Duration(cfgSettings.AppCloud.TimeoutMs)*time.Millisecond,
	)
	if !avatarClient.Enabled() {
		slog.Warn("[AVATAR] app-cloud avatar client disabled (base_url/api_key missing)")
	}
	settingsrouter.SetAvatarClient(avatarClient)
	settingsSvc := settingsservice.New(gdb)
	// Coding Plan (user configuration, settings domain): the app_pay membership
	// config is still defined in the auth config section and the AES cipher is
	// the shared one injected here.
	codingPlans := settingsservice.NewCodingPlanService(gdb, cfgAuth.AppPay, cipher)
	settingsEngine := settingsrouter.New(settingsrouter.Deps{
		Cfg:            cfgSettings,
		Svc:            settingsSvc,
		CodingPlans:    codingPlans,
		InternalAPIKey: cfgAuth.Internal.APIKey,
	})

	// Business timezone (after DB init: DSN loc is pinned to UTC above).
	if loc, lerr := time.LoadLocation(cfgAuth.Timezone); lerr == nil {
		time.Local = loc
	} else {
		slog.Warn("invalid timezone, falling back to UTC", "tz", cfgAuth.Timezone, "err", lerr)
	}

	// ── one listener: all three engines share the auth port. ──
	srvCfg := cfgAuth.Server
	readHeader := secondsOrDefault(srvCfg.ReadHeaderTimeoutSeconds, 5)
	readTimeout := secondsOrDefault(srvCfg.ReadTimeoutSeconds, 15)
	writeTimeout := secondsOrDefault(srvCfg.WriteTimeoutSeconds, 30)
	idleTimeout := secondsOrDefault(srvCfg.IdleTimeoutSeconds, 60)
	shutdownTimeout := secondsOrDefault(srvCfg.ShutdownTimeoutSeconds, 10)
	maxHeader := srvCfg.MaxHeaderBytes
	if maxHeader <= 0 {
		maxHeader = 1 << 20
	}
	handler := httpserver.Wrap(combinedHandler(authEngine, biliEngine, settingsEngine), httpserver.Config{
		MaxConnections:       srvCfg.MaxConnections,
		MaxConcurrent:        srvCfg.MaxConcurrent,
		MaxConcurrentPerIP:   srvCfg.MaxConcurrentPerIP,
		Compression:          srvCfg.Compression,
		KeepAliveMaxRequests: srvCfg.KeepAliveMaxRequests,
	})
	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", srvCfg.Host, srvCfg.Port),
		Handler:           handler,
		ConnContext:       httpserver.ConnContext,
		ReadHeaderTimeout: readHeader,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeader,
	}
	scheme := "http"
	if cfg.TLS.CertFile != "" {
		scheme = "https"
		server.TLSConfig = buildTLSConfig(cfg.TLS)
		if !srvCfg.HTTP2Enabled {
			server.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
			server.TLSConfig.NextProtos = []string{"http/1.1"}
		}
	}
	go func() {
		slog.Info("app-user listening", "addr", server.Addr, "scheme", scheme)
		var err error
		if scheme == "https" {
			err = server.ListenAndServeTLS(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			err = server.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			fatal("http server stopped", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutting down app-user")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "addr", server.Addr, "err", err)
	}
	slog.Info("app-user stopped")
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "app-user: %s: %v\n", msg, err)
	os.Exit(1)
}

// combinedHandler dispatches the legacy domain prefixes to their Gin engines
// behind one listener. The engines keep their own middleware/routes unchanged.
func combinedHandler(auth, bili, settings http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/health" || p == "/metrics" || p == "/debug/latency" ||
			strings.HasPrefix(p, "/auth/") || strings.HasPrefix(p, "/internal/auth/"):
			auth.ServeHTTP(w, r)
		case strings.HasPrefix(p, "/favorites") || strings.HasPrefix(p, "/knowledge") ||
			strings.HasPrefix(p, "/asr") || strings.HasPrefix(p, "/internal/bili"):
			bili.ServeHTTP(w, r)
		case p == "/preferences" || strings.HasPrefix(p, "/preferences/") ||
			p == "/avatar" || strings.HasPrefix(p, "/avatar/") ||
			strings.HasPrefix(p, "/settings/") || strings.HasPrefix(p, "/internal/settings/"):
			settings.ServeHTTP(w, r)
		default:
			auth.ServeHTTP(w, r)
		}
	})
}

func secondsOrDefault(seconds, fallback int) time.Duration {
	if seconds <= 0 {
		seconds = fallback
	}
	return time.Duration(seconds) * time.Second
}

func tlsMinVersion(raw string) uint16 {
	if strings.TrimSpace(raw) == "1.3" {
		return tls.VersionTLS13
	}
	return tls.VersionTLS12
}

func buildTLSConfig(cfg config.TLSConfig) *tls.Config {
	out := &tls.Config{MinVersion: tlsMinVersion(cfg.MinVersion)}
	if suites := cipherSuites(cfg.CipherSuites); len(suites) > 0 {
		out.CipherSuites = suites
	}
	if cfg.ClientCAFile != "" {
		if pem, err := os.ReadFile(cfg.ClientCAFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(pem) {
				out.ClientCAs = pool
			}
		}
	}
	switch strings.ToLower(strings.TrimSpace(cfg.ClientAuth)) {
	case "request":
		out.ClientAuth = tls.RequestClientCert
	case "require":
		out.ClientAuth = tls.RequireAnyClientCert
	case "verify_if_given":
		out.ClientAuth = tls.VerifyClientCertIfGiven
	case "require_and_verify":
		out.ClientAuth = tls.RequireAndVerifyClientCert
	}
	return out
}

func cipherSuites(names []string) []uint16 {
	if len(names) == 0 {
		return nil
	}
	known := map[string]uint16{
		"TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256":       tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		"TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384":       tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		"TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256":     tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		"TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384":     tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		"TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256": tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
	}
	out := make([]uint16, 0, len(names))
	for _, name := range names {
		if id, ok := known[strings.TrimSpace(name)]; ok {
			out = append(out, id)
		}
	}
	return out
}
