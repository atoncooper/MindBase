// Package router assembles the Gin engine: middleware chain, health probe,
// the APISIX forward-auth verify endpoint and the /auth/* user endpoints.
package router

import (
	"app-user/internal/infra/metrics"
	"app-user/internal/utils"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-user/internal/config"
	authdto "app-user/internal/dto/auth"
	"app-user/internal/router/middleware"
	"app-user/internal/service/auth"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg    *config.AuthConfig
	Health func(context.Context) error
	// RedisHealth is optional: Redis is a cache/security-state dependency, not
	// a hard request-path requirement, so an outage is reported in the body
	// (degraded) without failing readiness and pulling every instance.
	RedisHealth  func(context.Context) error
	Tokens       *service.TokenService
	Auth         *service.AuthService
	RBAC         *service.RBACService
	Verification *service.Verification
	Captcha      *service.CaptchaService
	Attestor     *service.DeviceAttestor
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
	e.Use(middleware.Recovery(), middleware.RequestID(), middleware.Metrics("auth"), middleware.AccessLog(), middleware.SecurityHeaders(), middleware.CORS(d.Cfg.SecurityCORS.AllowOrigins), middleware.BodyLimit(1<<20))

	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-user"}
		code := http.StatusOK
		if d.Health != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := d.Health(ctx); err != nil {
				body["status"] = "degraded"
				body["dependencies"] = "unavailable"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		if d.RedisHealth != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
			if err := d.RedisHealth(ctx); err != nil {
				body["redis"] = "down"
			} else {
				body["redis"] = "ok"
			}
			cancel()
		}
		c.JSON(code, body)
	})

	// Prometheus histogram + approximate in-process quantiles. Kept on the
	// auth listener (loopback-only in compose; not routed by APISIX/nginx).
	e.GET("/metrics", func(c *gin.Context) {
		c.Data(http.StatusOK, "text/plain; version=0.0.4; charset=utf-8", metrics.Default.Prometheus())
	})
	e.GET("/debug/latency", func(c *gin.Context) {
		c.JSON(http.StatusOK, metrics.Default.Quantiles())
	})

	registerInternalAuth(e, d)
	registerInternalUser(e, d)
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
			c.JSON(http.StatusOK, authdto.InternalVerify{OK: false})
			return
		}
		uid := d.Tokens.Validate(c.Request.Context(), token)
		if uid == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "token 无效或已过期"})
			return
		}
		// Status gate + roles are served from the authz cache on the steady
		// state (0 SQL per forward-auth request); a disabled account is
		// rejected here even while its opaque token has not expired.
		roles, err := d.Auth.Authorize(c.Request.Context(), uid)
		if err != nil {
			if errors.Is(err, service.ErrAccountDisabled) {
				c.JSON(http.StatusUnauthorized, gin.H{"detail": err.Error()})
				return
			}
			// Fail closed: if the status/role authority cannot be read we must
			// not hand a lenient 200 with no identity to the gateway.
			slog.Error("[AUTH_VERIFY] authorization failed", "uid", uid, "err", err)
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "认证服务暂不可用"})
			return
		}
		c.Header("X-Uid", strconv.FormatInt(uid, 10))
		if len(roles) > 0 {
			c.Header("X-Roles", strings.Join(roles, ","))
		}
		c.JSON(http.StatusOK, authdto.InternalVerify{OK: true, UID: uid})
	})
}

// extractToken reads the session token from the Authorization: Bearer header
// only. The legacy ?token= query form is deliberately gone: tokens in URLs
// leak through access logs, browser history and Referer headers.
func extractToken(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	if h == "" {
		return ""
	}
	scheme, value, _ := strings.Cut(h, " ")
	if strings.EqualFold(scheme, "bearer") {
		return strings.TrimSpace(value)
	}
	return ""
}

// requestContext bundles per-request metadata (ip/device) shared by handlers.
func requestContext(c *gin.Context) (ip string, deviceID string, ua string, meta utils.DeviceMeta) {
	ua = c.Request.Header.Get("User-Agent")
	acceptLang := c.Request.Header.Get("Accept-Language")
	deviceID = utils.DeriveDeviceID(ua, acceptLang)
	ip = utils.ClientIP(c.Request.Header.Get("X-Forwarded-For"),
		c.Request.Header.Get("X-Real-IP"), c.Request.RemoteAddr)
	meta = utils.ExtractDeviceMeta(ua)
	return
}

// apiErr renders a business error with the right status + Retry-After.
func apiErr(c *gin.Context, status int, detail string, retryAfter ...int) {
	if len(retryAfter) > 0 && retryAfter[0] > 0 {
		c.Header("Retry-After", strconv.Itoa(retryAfter[0]))
	}
	c.JSON(status, gin.H{"detail": detail})
}

// flowStatusHTTP maps a service-level flow classification to its status code.
func flowStatusHTTP(status service.FlowStatus) int {
	switch status {
	case service.FlowUnprocessable:
		return http.StatusUnprocessableEntity
	case service.FlowUnauthorized:
		return http.StatusUnauthorized
	case service.FlowForbidden:
		return http.StatusForbidden
	case service.FlowNotFound:
		return http.StatusNotFound
	case service.FlowConflict:
		return http.StatusConflict
	default:
		return http.StatusBadRequest
	}
}

// apiFlowErr renders a service account-flow error with its boundary status.
// Errors without a classification are business rejections (400).
func apiFlowErr(c *gin.Context, err error) {
	var fe *service.FlowError
	if errors.As(err, &fe) {
		apiErr(c, flowStatusHTTP(fe.Status), err.Error())
		return
	}
	apiErr(c, http.StatusBadRequest, err.Error())
}
