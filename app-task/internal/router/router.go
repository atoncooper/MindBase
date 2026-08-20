// Package router wires the Gin engine and HTTP handlers.
//
// File layout (one concern per file):
//   router.go   — engine assembly: New / Router / routes / CORS
//   task.go      — task endpoints (/tasks/*) + shared helpers
//   complete.go — async callback from third-party executors
//   script.go   — Lua script management (/scripts*)
package router

import (
	"log/slog"
	"net/http"
	"strings"

	"app-task/internal/config"
	"app-task/internal/executor"
	"app-task/internal/logger"
	"app-task/internal/service"

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

	r := &Router{taskSvc: taskSvc, emailSvc: emailSvc, luaExec: luaExec, cfg: cfg}
	r.registerRoutes(e)
	return e
}

type Router struct {
	taskSvc   *service.TaskService
	emailSvc *service.EmailService
	luaExec  *executor.LuaExecutor
	cfg      *config.Config
}

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-task"})
	})

	// Admin console (single binary): dedicated /login page + gated SPA at /
	// and /assets/*, backed by the /api/* endpoints below. Disabled entirely
	// (pages + API) when webui.enabled=false.
	if r.cfg.WebUI.Enabled {
		auth := newWebuiAuthenticator(r.cfg.WebUI.Token, r.cfg.WebUI.SessionTTLMinutes)
		registerWebRoutes(e, r.cfg, auth)
		r.registerWebuiRoutes(e, r.cfg, auth)
	}

	// Task endpoints: register / detail / list. A task is a pure scheduling
	// definition (task_type + payload + executor_url + cron + retry + weight);
	// the scheduler dispatches it to a third-party executor and records the
	// outcome in task_log.
	tasks := e.Group("/tasks")
	tasks.POST("/register", r.register)
	tasks.GET("/:task_id", r.detail)
	tasks.GET("", r.list)

	// Async callback: a third-party executor that accepted a task (202) reports
	// the final outcome here (key-auth). running -> completed | failed.
	e.POST("/internal/task/:task_id/complete", r.completeTask)

	// Mail delivery (platform capability): a third-party executor posts a
	// standardized email (to/cc/subject/html) here; app-task queues + delivers
	// it with retries (key-auth).
	e.POST("/internal/email/send", r.sendEmail)

	// Lua scripts (optional built-in executor, xxl-task GLUE-style): upload =
	// new version, takes effect immediately. Auth via APISIX key-auth; every
	// change is audit-logged.
	e.POST("/scripts", r.uploadScript)
	e.GET("/scripts", r.listScripts)
	e.GET("/scripts/logs", r.scriptLogs)
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
