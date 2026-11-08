// Package bootstrap is the single composition root for app-content: it opens
// ONE MySQL pool, ONE MongoDB client and ONE Redis client, creates ONE Gin
// engine, applies the shared middleware chain once, registers all three
// domains on that engine and serves it behind ONE *http.Server (one process,
// one HTTPS port). No domain opens its own connections or engine.
package bootstrap

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"strings"
	"time"

	"app-content/internal/config"
	boarddb "app-content/internal/infra/db/board"
	notedb "app-content/internal/infra/db/note"
	quizdb "app-content/internal/infra/db/quiz"
	appmongo "app-content/internal/infra/mongo"
	appmysql "app-content/internal/infra/mysql"
	appredis "app-content/internal/infra/redis"
	appboardtls "app-content/internal/infra/tls/board"
	"app-content/internal/metrics"
	"app-content/internal/middleware"

	"github.com/gin-gonic/gin"
)

// domain is one wired domain: only its readiness probe. Routes are registered
// on the process-wide Gin engine; data-store handles are owned by Run.
type domain struct {
	name string
	ping func(context.Context) error
}

// Run initializes the process, wires the shared data stores and every domain
// onto one Gin engine, then serves it on the single configured port until ctx
// is done.
func Run(ctx context.Context, cfg *config.Config) error {
	// HTTPS is mandatory. Only a non-production deployment may opt into
	// plaintext for local debugging, and only explicitly.
	insecureAllowed := os.Getenv("CONTENT__ALLOW_INSECURE_HTTP") == "true"
	if !cfg.Server.TLS.Enabled && (!insecureAllowed || cfg.App.Env == "production") {
		return fmt.Errorf("TLS is required (set CONTENT__SERVER__TLS__ENABLED=true; CONTENT__ALLOW_INSECURE_HTTP=true is dev-only)")
	}
	if err := cfg.ValidateDataStores(); err != nil {
		return err
	}

	// ── one process-wide data-store set ──────────────────────────────
	db, err := appmysql.Open(cfg.Database.MySQL.URL,
		cfg.Database.MySQL.MaxOpenConns, cfg.Database.MySQL.MaxIdleConns,
		cfg.Database.MySQL.ConnMaxLifetime, cfg.App.Debug)
	if err != nil {
		return fmt.Errorf("mysql: %w", err)
	}
	defer closeWithTimeout("mysql", func(ctx context.Context) error { return appmysql.Close(db) })

	if err := boarddb.Migrate(db); err != nil {
		return fmt.Errorf("board schema: %w", err)
	}
	if err := notedb.Migrate(db); err != nil {
		return fmt.Errorf("note schema: %w", err)
	}
	if err := quizdb.Migrate(db); err != nil {
		return fmt.Errorf("quiz schema: %w", err)
	}

	mongoClient, err := appmongo.Connect(ctx, cfg.Database.Mongo.URI, cfg.Database.Mongo.TimeoutSeconds)
	if err != nil {
		return fmt.Errorf("mongo: %w", err)
	}
	defer closeWithTimeout("mongo", func(ctx context.Context) error { return appmongo.Close(ctx, mongoClient) })

	sharedMongo := mongoClient.Database(cfg.Database.Mongo.Database)
	boardMongo := boardMongoDatabase(mongoClient, cfg)
	warnLegacyBoardDatabase(cfg)
	if err := appmongo.EnsureBoardIndexes(ctx, boardMongo); err != nil {
		return fmt.Errorf("board mongo indexes: %w", err)
	}

	redisClient, err := appredis.New(ctx, cfg.Database.Redis.URL)
	if err != nil {
		return fmt.Errorf("redis: %w", err)
	}
	defer closeWithTimeout("redis", func(context.Context) error { return appredis.Close(redisClient) })

	var registry *metrics.Registry
	if cfg.Observability.Metrics.Enabled {
		registry = metrics.New()
	}
	var limiter *middleware.RateLimiter
	if cfg.Security.RateLimit.Enabled {
		limiter = middleware.NewRateLimiter(cfg.Security.RateLimit)
		defer limiter.Close()
	}
	baseOpts := middleware.Options{
		TrustedProxies: cfg.Server.TrustedProxies,
		BodyLimits: map[string]int64{
			"/board":         cfg.Security.BodyLimits.BoardBytes,
			"/notes":         cfg.Security.BodyLimits.NoteBytes,
			"/internal/note": cfg.Security.BodyLimits.NoteBytes,
			"/quiz":          cfg.Security.BodyLimits.QuizBytes,
			"/tasks":         cfg.Security.BodyLimits.QuizBytes,
			"/internal/quiz": cfg.Security.BodyLimits.QuizBytes,
		},
		RequestID:   cfg.Security.RequestID,
		Headers:     cfg.Security.Headers,
		CORS:        cfg.Security.CORS,
		RateLimiter: limiter,
		Metrics:     registry,
	}

	// One engine for the whole process: shared middleware is installed once and
	// every domain only registers its routes on it.
	engine := gin.New()
	baseOpts.Apply(engine)

	domains := make([]*domain, 0, 3)
	boardDomain, err := setupBoard(ctx, cfg, engine, db, boardMongo, redisClient)
	if err != nil {
		return err
	}
	domains = append(domains, boardDomain)
	noteDomain, err := setupNote(ctx, cfg, engine, db, sharedMongo)
	if err != nil {
		return err
	}
	domains = append(domains, noteDomain)
	quizDomain, err := setupQuiz(ctx, cfg, engine, db, sharedMongo, redisClient)
	if err != nil {
		return err
	}
	domains = append(domains, quizDomain)

	mountSystem(engine, cfg, domains, registry)

	tlsCfg, rotatorStop, err := buildTLS(cfg)
	if err != nil {
		return err
	}
	if rotatorStop != nil {
		defer close(rotatorStop)
	}

	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:           engine,
		ReadHeaderTimeout: time.Duration(cfg.Server.Timeouts.ReadHeaderSeconds) * time.Second,
		ReadTimeout:       time.Duration(cfg.Server.Timeouts.ReadSeconds) * time.Second,
		WriteTimeout:      time.Duration(cfg.Server.Timeouts.WriteSeconds) * time.Second,
		IdleTimeout:       time.Duration(cfg.Server.Timeouts.IdleSeconds) * time.Second,
		MaxHeaderBytes:    cfg.Server.MaxHeaderBytes,
		TLSConfig:         tlsCfg,
	}
	if !cfg.Server.HTTP2 {
		// Disable Go's automatic HTTP/2 upgrade while keeping TLS.
		srv.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("app-content listening",
			"addr", srv.Addr, "tls", cfg.Server.TLS.Enabled, "http2", cfg.Server.HTTP2,
			"env", cfg.App.Env, "domains", "board,note,quiz")
		var serveErr error
		if cfg.Server.TLS.Enabled {
			serveErr = srv.ListenAndServeTLS("", "")
		} else {
			serveErr = srv.ListenAndServe()
		}
		if serveErr != nil && serveErr != http.ErrServerClosed {
			errCh <- serveErr
		}
	}()

	select {
	case <-ctx.Done():
	case serveErr := <-errCh:
		shutdown(srv, cfg.Server.GracefulShutdownSeconds)
		return fmt.Errorf("http server: %w", serveErr)
	}
	return shutdown(srv, cfg.Server.GracefulShutdownSeconds)
}

// closeWithTimeout runs a data-store close hook with a bounded context.
func closeWithTimeout(name string, close func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := close(ctx); err != nil {
		slog.Warn("[BOOT] close failed", "store", name, "err", err)
	}
}

func shutdown(srv *http.Server, seconds int) error {
	if seconds <= 0 {
		seconds = 15
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func slogWarn(msg string, err error) { slog.Warn(msg, "err", err) }

func buildTLS(cfg *config.Config) (*tls.Config, chan struct{}, error) {
	if !cfg.Server.TLS.Enabled {
		return nil, nil, nil
	}
	rotator, err := appboardtls.NewRotator(cfg.Server.TLS.Cert, cfg.Server.TLS.Key, cfg.Server.TLS.CertDir, cfg.Server.TLS.RotateWithinDays)
	if err != nil {
		return nil, nil, fmt.Errorf("tls: %w", err)
	}
	rotator.Summary()
	stop := make(chan struct{})
	rotator.Start(stop)
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			return rotator.GetCertificate(hello)
		},
	}
	if cfg.Server.TLS.MinVersion == "1.3" {
		tlsCfg.MinVersion = tls.VersionTLS13
	}
	switch cfg.Server.TLS.ClientAuth {
	case "request":
		tlsCfg.ClientAuth = tls.RequestClientCert
	case "require":
		tlsCfg.ClientAuth = tls.RequireAndVerifyClientCert
	}
	if tlsCfg.ClientAuth != tls.NoClientCert {
		caFile := strings.TrimSpace(cfg.Server.TLS.ClientCAFile)
		if caFile == "" {
			return nil, nil, fmt.Errorf("tls.client_auth=%s requires server.tls.client_ca_file", cfg.Server.TLS.ClientAuth)
		}
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, nil, fmt.Errorf("tls: read client CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, nil, fmt.Errorf("tls: client CA file %q contains no certificates", caFile)
		}
		tlsCfg.ClientCAs = pool
	}
	return tlsCfg, stop, nil
}

// mountSystem registers the aggregated health/metrics/pprof endpoints and the
// shared 404/405 fallbacks on the same Gin engine every domain uses.
func mountSystem(engine *gin.Engine, cfg *config.Config, domains []*domain, registry *metrics.Registry) {
	checkers := make([]HealthChecker, 0, len(domains))
	for _, d := range domains {
		checkers = append(checkers, HealthChecker{Name: d.name, Ping: d.ping})
	}
	engine.GET("/health", gin.WrapF(healthHandlerWithTimeout(checkers, cfg.Observability.Health.TimeoutSeconds)))
	if registry != nil {
		path := cfg.Observability.Metrics.Path
		if path == "" {
			path = "/metrics"
		}
		engine.GET(path, gin.WrapH(registry.Handler()))
	}
	if cfg.Observability.Pprof.Enabled {
		engine.GET("/debug/pprof/*any", gin.WrapF(pprofDispatch))
	}
	engine.HandleMethodNotAllowed = true
	engine.NoRoute(middleware.JSONNotFound)
	engine.NoMethod(middleware.JSONMethodNotAllowed)
}

// pprofDispatch routes every /debug/pprof/* request to the stdlib handlers
// (Index itself does not serve cmdline/profile/symbol/trace).
func pprofDispatch(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, "/debug/pprof/") {
	case "cmdline":
		pprof.Cmdline(w, r)
	case "profile":
		pprof.Profile(w, r)
	case "symbol":
		pprof.Symbol(w, r)
	case "trace":
		pprof.Trace(w, r)
	default:
		pprof.Index(w, r)
	}
}

// HealthChecker is one domain's readiness probe.
type HealthChecker struct {
	Name string
	Ping func(context.Context) error
}

// HealthHandler is the exported convenience wrapper (tests/ops) with a 2s
// default timeout.
func HealthHandler(checkers []HealthChecker) http.HandlerFunc {
	return healthHandlerWithTimeout(checkers, 2)
}

func healthHandlerWithTimeout(checkers []HealthChecker, timeoutSeconds int) http.HandlerFunc {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 2
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSeconds)*time.Second)
		defer cancel()
		body := map[string]any{"status": "ok", "service": "app-content"}
		states := make(map[string]string, len(checkers))
		code := http.StatusOK
		for _, d := range checkers {
			if d.Ping == nil {
				states[d.Name] = "ok"
				continue
			}
			if err := d.Ping(ctx); err != nil {
				states[d.Name] = "storage_down"
				code = http.StatusServiceUnavailable
				continue
			}
			states[d.Name] = "ok"
		}
		if code != http.StatusOK {
			body["status"] = "degraded"
		}
		body["domains"] = states
		writeJSON(w, code, body)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
