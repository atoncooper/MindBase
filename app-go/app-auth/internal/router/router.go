// Package router assembles the Gin engine: middleware chain, health probe,
// the APISIX forward-auth verify endpoint and the /auth/* user endpoints.
package router

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"app-auth/internal/config"
	"app-auth/internal/logger"
	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg          *config.Config
	Tokens       *service.TokenService
	Auth         *service.AuthService
	RBAC         *service.RBACService
	Verification *service.Verification
	Captcha      *service.CaptchaService
	Throttle     *service.LoginThrottle
	IPGuard      *service.FixedWindowLimiter
	RateLimits   *service.RateLimits
	WeChat       *service.WeChatService
	Passport     *service.BilibiliPassport
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil) // X-Forwarded-For comes only from our own gateway
	e.Use(logger.GinRecovery(), logger.GinLogger(), securityHeaders(), cors(d.Cfg))

	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "app-auth"})
	})

	registerInternalAuth(e, d)
	registerAuth(e, d)
	return e
}

// registerInternalAuth mounts the APISIX forward-auth endpoint:
//
//	GET /internal/auth/verify   (Authorization: Bearer <bili_session>)
//
// Semantics ("lenient verify"):
//   - no credentials       → 200 WITHOUT identity headers (public endpoints
//     behind catch_all must survive; protected services 401 on a missing
//     X-Uid themselves). Client-supplied X-Uid/X-Roles are stripped by
//     proxy-rewrite on every forward-auth route, so an absent identity
//     here cannot be spoofed.
//   - credentials, invalid → 401 (the gateway rejects the request).
//   - credentials, valid   → 200 + X-Uid (+ X-Roles) headers that APISIX
//     injects into the upstream request.
func registerInternalAuth(e *gin.Engine, d Deps) {
	e.GET("/internal/auth/verify", func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			c.JSON(http.StatusOK, gin.H{"ok": false})
			return
		}
		uid := d.Tokens.Validate(c.Request.Context(), token)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "token 无效或已过期"})
			return
		}
		roles, err := d.RBAC.GetUserRoles(c.Request.Context(), uid)
		if err != nil {
			// Role lookup failure must not fail the whole auth check —
			// treat as roleless (deny admin, allow normal access).
			slog.Warn("[AUTH_VERIFY] role lookup failed", "uid", uid, "err", err)
			roles = nil
		}
		c.Header("X-Uid", strconv.FormatInt(uid, 10))
		if len(roles) > 0 {
			c.Header("X-Roles", strings.Join(roles, ","))
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "uid": uid})
	})
}

// extractToken reads the session token from the Authorization header
// (Bearer) or the ?token= query param — parity with the Python backend.
func extractToken(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); h != "" {
		scheme, value, _ := strings.Cut(h, " ")
		if strings.EqualFold(scheme, "bearer") {
			return strings.TrimSpace(value)
		}
	}
	if t := c.Query("token"); t != "" {
		return strings.TrimSpace(t)
	}
	return ""
}

// requestContext bundles per-request metadata (ip/device) shared by handlers.
func requestContext(c *gin.Context) (ip string, deviceID string, ua string, meta service.DeviceMeta) {
	ua = c.Request.Header.Get("User-Agent")
	acceptLang := c.Request.Header.Get("Accept-Language")
	deviceID = service.DeriveDeviceID(ua, acceptLang)
	ip = service.ClientIP(c.Request.Header.Get("X-Forwarded-For"),
		c.Request.Header.Get("X-Real-IP"), c.Request.RemoteAddr)
	meta = service.ExtractDeviceMeta(ua)
	return
}

// securityHeaders sets conservative defaults on every response.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// cors echoes whitelisted origins from config (same stance as the other Go
// services; auth endpoints are consumed same-origin by the frontend).
func cors(cfg *config.Config) gin.HandlerFunc {
	allowed := make(map[string]bool, len(cfg.SecurityCORS.AllowOrigins))
	for _, o := range cfg.SecurityCORS.AllowOrigins {
		allowed[strings.TrimSpace(o)] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, If-Match")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// apiErr renders a business error with the right status + Retry-After.
func apiErr(c *gin.Context, status int, detail string, retryAfter ...int) {
	if len(retryAfter) > 0 && retryAfter[0] > 0 {
		c.Header("Retry-After", strconv.Itoa(retryAfter[0]))
	}
	c.JSON(status, gin.H{"detail": detail})
}
