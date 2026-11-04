// Package router wires the Gin engine and HTTP handlers for the unified admin
// console: share moderation + payment operations + console
// account management (docs/app-admin.md). No SSR pages:
// JSON API only + /health, matches the frontend-admin SPA contract.
//
// File layout (one concern per file):
//
//	router.go        - engine assembly / Deps / health / middleware helpers
//	auth.go          - login / logout / me / password + session gate + throttle
//	users.go         - read-only business user list / detail
//	shares.go        - share list / detail / ban / unban / approve (role gate)
//	audit.go         - audit ledger list
//	sandbox.go       - sandbox console proxy (reads viewer+, cancel/release admin)
//	pay.go           - payment queries / grant / refund review (/api/pay/**)
//	console_users.go - console account management (/api/console/users)
package router

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/logger"
	"app-admin/internal/payops"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

// Deps bundles every service the handlers need. Optional planes (sandbox, pay)
// may be nil: their routes then answer 503 while the rest of the console keeps
// working (fail closed per plane, never fail the process).
type Deps struct {
	Auth    *service.AuthService
	Users   *service.UserService
	Shares  *service.ShareService
	Audits  *service.AuditService
	Sandbox *service.SandboxService
	// Pay is non-nil ONLY when pay_rdbms.url is configured AND the second GORM
	// connection initialized. nil makes every /api/pay/** route answer
	// 503 {"detail":"支付管理未配置"} after login.
	Pay    *service.PayQueryService
	Grants *service.PayGrantService
	// Console is the admin_user account-management service (always available —
	// it does not touch the payment database).
	Console *service.ConsoleUserService
	// Ops is the app-pay internal client backing the refund review workbench.
	Ops *payops.Client
	// PayAudit is the fund-operation JSONL sink (pay-audit.jsonl hash chain).
	// Shared with Grants; nil when the pay module is disabled.
	PayAudit *service.PayAudit
}

// Router carries the service dependencies for all handlers.
type Router struct {
	cfg *config.Config
	// trustedProxies are the reverse proxies whose X-Forwarded-* headers may be
	// believed (empty = trust none, use the TCP peer address).
	trustedProxies []*net.IPNet
	auth           *service.AuthService
	users          *service.UserService
	shares         *service.ShareService
	audits         *service.AuditService
	sandbox        *service.SandboxService
	pay            *service.PayQueryService
	grants         *service.PayGrantService
	console        *service.ConsoleUserService
	ops            *payops.Client
	payAudit       *service.PayAudit
}

// New builds the Gin engine: strict proxies, structured access log, security
// headers, optional CORS whitelist, /health + /api/*.
//
// A nil Deps field falls back to the disabled/no-op service so tests and
// degraded deployments can omit optional planes without nil dereferences.
func New(cfg *config.Config, deps Deps) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	// Defensive defaults for omitted dependencies (tests may build a router
	// with only the plane they exercise; routes then answer 503/401 instead of
	// panicking on nil).
	if deps.Auth == nil {
		deps.Auth = service.NewAuthService(0)
	}
	if deps.Users == nil {
		deps.Users = service.NewUserService()
	}
	if deps.Shares == nil {
		deps.Shares = service.NewShareService(nil)
	}
	if deps.Audits == nil {
		deps.Audits = service.NewAuditService()
	}
	if deps.Sandbox == nil {
		deps.Sandbox = service.NewSandboxService(nil)
	}
	if deps.Console == nil {
		deps.Console = service.NewConsoleUserService()
	}

	// Proxy trust is explicit: gin's default (trust everything) would let a
	// client spoof X-Forwarded-For to sidestep the login throttle / logging.
	// The configured proxy list is parsed here once; an invalid entry is a
	// warning and turns trust OFF (fail closed) instead of failing startup.
	trustedProxies, err := parseTrustedProxies(cfg.Security.TrustedProxies)
	if err != nil {
		slog.Warn("[SECURITY] invalid trusted_proxies entry — forwarded headers will NOT be trusted", "err", err)
		trustedProxies = nil
	}

	e := gin.New()
	_ = e.SetTrustedProxies(nil)
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(securityHeaders())
	e.Use(ipAllowlistMiddleware(cfg.Security.IPAllowlist))
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins, trustedProxies))

	r := &Router{
		cfg:            cfg,
		trustedProxies: trustedProxies,
		auth:           deps.Auth,
		users:          deps.Users,
		shares:         deps.Shares,
		audits:         deps.Audits,
		sandbox:        deps.Sandbox,
		pay:            deps.Pay,
		grants:         deps.Grants,
		console:        deps.Console,
		ops:            deps.Ops,
		payAudit:       deps.PayAudit,
	}
	r.registerRoutes(e)
	return e
}

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", r.health)

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

	// Sandbox console proxy: reads are viewer+, cancel
	// execution / release lease are admin-only. app-sandbox stays the single
	// source of truth for sandbox state; app-admin only gates, proxies and audits.
	r.registerSandboxRoutes(api)

	// Payment operations: /api/pay/** is gated on the
	// second connection; refund review additionally hides itself (404) unless
	// the ops key/switch are wired.
	r.registerPayRoutes(api)

	// Console account management: admin_user accounts, admin
	// only, independent of the payment database.
	r.registerConsoleUserRoutes(api)
}

// health truthfully probes the databases:
//   - main DB down                      -> 503 {"detail":"database unavailable"}
//   - pay_rdbms.url set but PayDB down  -> 503 {"detail":"pay database unavailable"}
//   - otherwise                         -> 200 {status, service, pay:"ok"|"disabled"}
//
// The pay module being intentionally unconfigured is NOT an outage: the rest
// of the console keeps serving with pay:"disabled".
func (r *Router) health(c *gin.Context) {
	if err := db.Ping(); err != nil {
		detail(c, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	pay := "disabled"
	if db.PayAvailable() {
		if err := db.PayPing(); err != nil {
			detail(c, http.StatusServiceUnavailable, "pay database unavailable")
			return
		}
		pay = "ok"
	} else if strings.TrimSpace(r.cfg.PayRDBMS.URL) != "" {
		// Configured but the connection never came up (init failed / dropped).
		detail(c, http.StatusServiceUnavailable, "pay database unavailable")
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-admin", "pay": pay})
}

// securityHeaders adds baseline admin-console hardening: no framing, no MIME
// sniffing, no referrer leakage, no cross-origin embedding of console
// responses, no-store on JSON so moderation data never lands in shared caches.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Content-Security-Policy", "frame-ancestors 'none'")
		c.Header("Cross-Origin-Resource-Policy", "same-origin")
		c.Header("Cross-Origin-Opener-Policy", "same-origin")
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
