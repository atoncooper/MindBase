// Package router wires the Gin engine and HTTP handlers for the pay admin
// console.
//
// File layout (one concern per file):
//
//	router.go      — engine assembly: New / Router / CORS / security headers
//	webui.go       — authenticator (login/session/throttle) + /api/* registration
//	console.go     — page gating: /login + gated SPA at / + noHTMLFS
//	orders.go      — order list/detail/callbacks (pay_order, pay_callback_log)
//	memberships.go — membership + entitlement events (pay_membership[_event])
//	products.go    — SKU catalog (pay_product, read-only)
//	grant.go       — POST /api/grants (membership grant, admin-only)
//	users.go       — console account management (payadmin_user, admin-only)
//
// Unlike app-task there are NO APISIX-facing endpoints: the whole service is a
// loopback admin console gated by its own account store.
package router

import (
	"strings"

	"app-pay-admin/internal/config"
	"app-pay-admin/internal/logger"
	"app-pay-admin/internal/service"

	"github.com/gin-gonic/gin"
	"net/http"
)

func New(cfg *config.Config, grants *service.GrantService) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	// Trust no proxy: the login throttle keys on c.ClientIP(), and gin's
	// default (trust everything) lets any client spoof X-Forwarded-For to
	// sidestep it. With no trusted proxy the peer address is always used.
	_ = e.SetTrustedProxies(nil)
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(securityHeaders())
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins))

	r := &Router{cfg: cfg, grants: grants}
	r.registerRoutes(e)
	return e
}

type Router struct {
	cfg    *config.Config
	grants *service.GrantService
}

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-pay-admin"})
	})

	// Admin console (single binary): server-rendered pages (html/template) +
	// the /api/* JSON group for scripts/master-token callers. Disabled
	// entirely when webui.enabled=false.
	if r.cfg.WebUI.Enabled {
		auth := newWebuiAuthenticator(r.cfg.WebUI.Token, r.cfg.WebUI.SessionTTLMinutes)
		r.registerPages(e, auth)
		r.registerWebuiRoutes(e, auth)
	}
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
			// X-WebUI-Token is the console's own header; without it here a
			// cross-origin browser client fails CORS preflight.
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id, X-WebUI-Token")
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
// payment data never lands in shared caches.
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
