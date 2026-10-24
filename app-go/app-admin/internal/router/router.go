// Package router wires the Gin engine and HTTP handlers for the share-
// moderation admin console (plan/1.0.16 section 5). No SSR pages: JSON API
// only + /health, matches the frontend-admin SPA contract.
//
// File layout (one concern per file):
//
//	router.go - engine assembly / health / middleware helpers
//	auth.go   - login / logout / me / password + session gate + throttle
//	users.go  - read-only user list / detail
//	shares.go - share list / detail / ban / unban / approve (role gate)
//	audit.go  - audit ledger list
package router

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/logger"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

// Router carries the service dependencies for all handlers.
type Router struct {
	cfg    *config.Config
	auth   *service.AuthService
	users  *service.UserService
	shares *service.ShareService
	audits *service.AuditService
}

// New builds the Gin engine: strict proxies, structured access log, security
// headers, optional CORS whitelist, /health + /api/*.
func New(cfg *config.Config, auth *service.AuthService, users *service.UserService,
	shares *service.ShareService, audits *service.AuditService) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	// Trust no proxy: gin's default (trust everything) lets clients spoof
	// X-Forwarded-For to sidestep the login throttle / ClientIP logging. With
	// no trusted proxy the peer address is always used.
	_ = e.SetTrustedProxies(nil)
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(securityHeaders())
	e.Use(ipAllowlistMiddleware(cfg.Security.IPAllowlist))
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins))

	r := &Router{cfg: cfg, auth: auth, users: users, shares: shares, audits: audits}
	r.registerRoutes(e)
	return e
}

func (r *Router) registerRoutes(e *gin.Engine) {
	// /health truthfully probes the DB (SELECT 1 via sql.Ping); 503 when the
	// shared MySQL is unreachable so orchestrators do not route to a console
	// that cannot moderate anything.
	e.GET("/health", func(c *gin.Context) {
		if err := db.Ping(); err != nil {
			detail(c, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-admin"})
	})

	// Login sits OUTSIDE the gate (it IS the credential check); logout
	// authenticates with the very session it invalidates.
	e.POST("/api/login", r.apiLogin)

	api := e.Group("/api", r.sessionGate())
	api.POST("/logout", r.apiLogout)
	api.GET("/me", r.apiMe)
	api.POST("/me/password", r.apiChangePassword) // any logged-in account
	api.GET("/users", r.apiListUsers)             // viewer+
	api.GET("/users/:uid", r.apiUserDetail)       // viewer+
	api.GET("/shares", r.apiListShares)           // viewer+
	api.GET("/shares/:id", r.apiShareDetail)      // viewer+
	api.GET("/audit", r.apiListAudit)             // viewer+

	// Moderation writes: admin role only.
	moderation := api.Group("/shares/:id", requireAdmin())
	moderation.POST("/ban", r.apiBan)
	moderation.POST("/unban", r.apiUnban)
	moderation.POST("/approve", r.apiApprove)
	// Controlled content preview (admin role only): app-admin validates the
	// share/target scope + audits, app-cloud resolves the disclosure ack and
	// mints the short-lived INLINE grant. viewer role gets 403.
	moderation.GET("/files/:file_id/preview", r.apiPreviewShareFile)
}

// securityHeaders adds baseline admin-console hardening: no framing, no MIME
// sniffing, no referrer leakage, no-store on JSON so moderation data never
// lands in shared caches.
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

// Error body contract: {"detail": ...} for every failure (matches pay-admin).
func detail(c *gin.Context, status int, msg string) {
	c.JSON(status, gin.H{"detail": msg})
}

// badRequest echoes a one-line validation problem.
func badRequest(c *gin.Context, err error) {
	detail(c, http.StatusBadRequest, fmt.Sprintf("%v", err))
}

// serverError logs the real cause and returns an opaque message.
func serverError(c *gin.Context, err error, what string) {
	slog.Error("[HTTP] handler error", "what", what, "err", err)
	detail(c, http.StatusInternalServerError, "internal error")
}
