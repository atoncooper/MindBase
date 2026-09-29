// Package router wires the Gin engine and HTTP handlers.
//
// File layout (one concern per file):
//
//	router.go   — engine assembly: New / Router / routes / CORS
//	task.go      — task endpoints (/tasks/*) + shared helpers
//	complete.go — async callback from third-party executors
//	script.go   — Lua script management (/scripts*)
package router

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"app-task/internal/config"
	"app-task/internal/executor"
	"app-task/internal/logger"
	"app-task/internal/repo"
	"app-task/internal/security"
	"app-task/internal/service"

	"app-task/internal/cluster"

	"github.com/gin-gonic/gin"
)

func New(taskSvc *service.TaskService, emailSvc *service.EmailService, luaExec *executor.LuaExecutor, cfg *config.Config) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	// Trust no proxy: the webui login throttle keys on c.ClientIP(), and gin's
	// default (trust everything) lets any client spoof X-Forwarded-For to
	// sidestep it. With no trusted proxy the peer address is always used.
	// Side effect: audit-log source_ip for APISIX-routed calls shows the
	// apisix container IP instead of the end user - accepted tradeoff.
	_ = e.SetTrustedProxies(nil)
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(securityHeaders())
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins))

	if cfg.WebUI.Enabled && cfg.WebUI.Token == "" {
		slog.Warn("webui master token not set (optional API key); console login is " +
			"username/password — the default admin/app-task-admin account is active, " +
			"change its password in the console account page")
	}

	// Central secret store resolver: ctx.secret(name) in Lua scripts reads
	// from the encrypted secret table. Needs the encryption key; without it
	// ctx.secret fails with a clear message (feature disabled).
	if cfg.Security.SecretEncKey != "" {
		if cipher, cerr := security.NewCipher(cfg.Security.SecretEncKey); cerr == nil {
			luaExec.Secrets = func(name string) (string, error) {
				row, err := repo.GetSecretByName(name)
				if err != nil {
					return "", err
				}
				if row == nil {
					return "", fmt.Errorf("secret not found: %s", name)
				}
				return cipher.Decrypt(row.ValueEnc)
			}
		} else {
			slog.Error("secret encryption key invalid", "err", cerr)
		}
	}
	// Console state stores: memory by default (single instance, zero
	// dependencies); Redis when webui.session_store=redis (multi-instance
	// deployments share sessions, key reveals and throttles). A missing or
	// malformed redis URL fails loud — half-configured console state is worse
	// than none.
	var sessStore sessionStore
	throttle := throttler(newMemoryThrottler(webuiMaxFails, webuiFailWindow))
	limiter := keyRateLimiter(newMemoryLimiter())
	reveals := revealStore(newMemoryRevealStore())
	if cfg.WebUI.SessionStore == "redis" {
		if cfg.Redis.URL == "" {
			panic("webui.session_store=redis requires redis.url (env APPTASK__REDIS__URL or shared REDIS__URL)")
		}
		rdb, err := newRedisClient(cfg.Redis)
		if err != nil {
			panic("webui.session_store=redis: bad redis.url: " + err.Error())
		}
		if err := rdb.Ping(context.Background()).Err(); err != nil {
			slog.Error("[WEBUI] redis ping failed — throttles fail open, but logins need redis back", "err", err)
		}
		sessStore = newRedisSessionStore(rdb)
		throttle = newRedisThrottler(rdb, webuiMaxFails, webuiFailWindow)
		limiter = newRedisLimiter(rdb)
		reveals = newRedisRevealStore(rdb)
		slog.Info("[WEBUI] redis-backed console state enabled")
	}
	r := &Router{taskSvc: taskSvc, emailSvc: emailSvc, luaExec: luaExec, cfg: cfg,
		keys: newKeyService(throttle, limiter, reveals), sessStore: sessStore}
	r.registerRoutes(e)
	return e
}

// Service-body caps (boundary hardening): the JSON bodies accepted by the
// key-authenticated service endpoints are bounded regardless of caller.
const (
	maxTaskPayloadBytes = 64 << 10  // /tasks/register + /internal/script/run payload
	maxEmailBodyBytes   = 256 << 10 // /internal/email/send (HTML bodies can be sizable)
)

type Router struct {
	taskSvc     *service.TaskService
	emailSvc    *service.EmailService
	luaExec     *executor.LuaExecutor
	cfg         *config.Config
	keys        *keyService
	sessStore   sessionStore // console session backing (memory or redis)
	consoleAuth *webuiAuthenticator
}

// schedulerStats is wired from main (SetSchedulerStats) so /api/stats can
// expose the dispatch pool gauges without threading the scheduler through
// the Router constructor. Nil when unset (tests) — stats simply omit it.
var schedulerStats func() (workers int, inflight int64)

// SetSchedulerStats attaches the running scheduler's pool gauges.
func SetSchedulerStats(fn func() (workers int, inflight int64)) { schedulerStats = fn }

// clusterMgr is wired from main (SetClusterManager) for the /api/cluster
// roster endpoint. Nil when unset — the endpoint then returns an empty roster.
var clusterMgr *cluster.Manager

// SetClusterManager attaches the cluster node roster.
func SetClusterManager(m *cluster.Manager) { clusterMgr = m }

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-task"})
	})

	// Admin console (single binary): server-rendered html/template pages
	// (POST-redirect-GET + flash) + the /api/* JSON group below. Disabled
	// entirely (pages + API) when webui.enabled=false.
	if r.cfg.WebUI.Enabled {
		auth := newWebuiAuthenticator(r.cfg.WebUI.Token, r.cfg.WebUI.SessionTTLMinutes, r.sessStore, nil)
		r.consoleAuth = auth
		r.registerPages(e, auth)
		r.registerWebuiRoutes(e, r.cfg, auth)
	}

	// Bootstrap service keys (e.g. the APISIX consumer key) so gateway-routed
	// calls pass the API-key middleware with no manual setup.
	requireBootstrapKeys(r.cfg.Security.ServiceKeys)

	// Backfill UUID identifiers for rows created before the uuid columns
	// existed (webui_user / secret legacy rows).
	if err := repo.EnsureUserIDs(); err != nil {
		slog.Error("[BACKFILL] user ids failed", "err", err)
	}
	if err := repo.EnsureSecretIDs(); err != nil {
		slog.Error("[BACKFILL] secret ids failed", "err", err)
	}

	// Service surface: every call must carry a valid API key. The gateway's
	// key-auth only guards the APISIX hop — this middleware is the authority
	// at the app-task port itself, so a direct connection cannot bypass it.
	svc := e.Group("", r.apiKeyAuthMiddleware(r.keys))

	// Task endpoints: register / detail / list. A task is a pure scheduling
	// definition (task_type + payload + executor_url + cron + retry + weight);
	// the scheduler dispatches it to a third-party executor and records the
	// outcome in task_log.
	tasks := svc.Group("/tasks")
	tasks.POST("/register", r.register)
	tasks.GET("/:task_id", r.detail)
	tasks.GET("", r.list)

	// Async callback: a third-party executor that accepted a task (202) reports
	// the final outcome here (key-auth). running -> completed | failed.
	svc.POST("/internal/task/:task_id/complete", r.completeTask)

	// Mail delivery (platform capability): a third-party executor posts a
	// standardized email (to/cc/subject/html) here; app-task queues + delivers
	// it with retries (key-auth).
	svc.POST("/internal/email/send", r.sendEmail)

	// Script run (platform capability): on-demand execution of a registered
	// Lua script (script_id + payload), synchronous with the result JSON.
	// Same pipeline as scheduled dispatch; runs are persisted to script_run.
	svc.POST("/internal/script/run", r.runScriptAPI)

	// Lua scripts (optional built-in executor, xxl-task GLUE-style): upload =
	// new version, takes effect immediately. Auth via APISIX key-auth; every
	// change is audit-logged.
	svc.POST("/scripts", r.uploadScript)
	svc.GET("/scripts", r.listScripts)
	svc.GET("/scripts/logs", r.scriptLogs)
}

func corsMiddleware(allowOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, o := range allowOrigins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			// X-WebUI-Token/X-Operator are the console's own headers; without
			// them here a cross-origin browser client fails CORS preflight.
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id, X-WebUI-Token, X-Operator")
			c.Header("Access-Control-Max-Age", "600")
			// The origin is reflected, so caches must not share responses
			// across origins.
			c.Header("Vary", "Origin")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// securityHeaders adds baseline hardening for the admin console: no framing
// (clickjacking), no MIME sniffing, no referrer leakage, and no-store so
// admin data never lands in shared caches.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Content-Security-Policy", "frame-ancestors 'none'")
		c.Header("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Header("Cache-Control", "no-store")
		}
		c.Next()
	}
}
