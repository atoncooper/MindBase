// Package middleware is the shared HTTP security/plumbing layer for all three
// content domains. Everything is driven by the process-wide security/server
// config; routers only opt in with middleware.Options.
package middleware

import (
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-content/internal/apperr"
	"app-content/internal/config"
	"app-content/internal/logger"
	"app-content/internal/metrics"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Options is the process-wide middleware configuration derived from the root
// server/security config. It is applied exactly once to the single Gin engine
// owned by the composition root.
type Options struct {
	TrustedProxies []string
	// BodyLimit is a global cap; BodyLimits overrides it per path prefix
	// (longest prefix wins), used because the three domains have different
	// payload budgets on the shared engine.
	BodyLimit   int64
	BodyLimits  map[string]int64
	RequestID   config.RequestIDConfig
	Headers     config.HeadersConfig
	CORS        config.CORSConfig
	RateLimiter *RateLimiter
	Metrics     *metrics.Registry
}

// Apply installs the common chain on an engine.
func (o Options) Apply(e *gin.Engine) {
	_ = e.SetTrustedProxies(o.TrustedProxies)
	e.Use(logger.GinRecovery())
	e.Use(RequestIDWith(o.RequestID))
	e.Use(logger.GinLogger())
	e.Use(SecurityHeadersWith(o.Headers))
	e.Use(CORSWith(o.CORS))
	if len(o.BodyLimits) > 0 {
		e.Use(BodyLimitByPrefix(o.BodyLimits))
	} else if o.BodyLimit > 0 {
		e.Use(BodyLimit(o.BodyLimit))
	}
	if o.RateLimiter != nil {
		e.Use(o.RateLimiter.Handler())
	}
	if o.Metrics != nil {
		e.Use(o.Metrics.Middleware())
	}
}

// RequestIDWith propagates/caps the trace id.
func RequestIDWith(cfg config.RequestIDConfig) gin.HandlerFunc {
	header := strings.TrimSpace(cfg.Header)
	if header == "" {
		header = "X-Request-Id"
	}
	maxLen := cfg.MaxLength
	if maxLen <= 0 {
		maxLen = 64
	}
	return func(c *gin.Context) {
		id := sanitizeRequestID(c.GetHeader(header), maxLen)
		if id == "" {
			id = uuid.NewString()
		}
		c.Set("request_id", id)
		c.Header(header, id)
		c.Request = c.Request.WithContext(logger.IntoContext(c.Request.Context(), id))
		c.Next()
	}
}

// sanitizeRequestID keeps only log-safe characters and caps the length, so a
// client cannot forge multi-line/structured log entries via X-Request-Id.
func sanitizeRequestID(raw string, maxLen int) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range raw {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == ':' {
			b.WriteRune(r)
		}
	}
	id := b.String()
	if len(id) > maxLen {
		id = id[:maxLen]
	}
	return id
}

// SecurityHeadersWith applies the configured baseline headers.
func SecurityHeadersWith(cfg config.HeadersConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		if cfg.ContentTypeOptions != "" {
			c.Header("X-Content-Type-Options", cfg.ContentTypeOptions)
		}
		if cfg.FrameOptions != "" {
			c.Header("X-Frame-Options", cfg.FrameOptions)
		}
		if cfg.ReferrerPolicy != "" {
			c.Header("Referrer-Policy", cfg.ReferrerPolicy)
		}
		if cfg.PermissionsPolicy != "" {
			c.Header("Permissions-Policy", cfg.PermissionsPolicy)
		}
		if cfg.HSTSEnabled {
			c.Header("Strict-Transport-Security",
				"max-age="+strconv.Itoa(cfg.HSTSMaxAgeSeconds)+"; includeSubDomains")
		}
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// CORSWith reflects the configured allow-list (credentials aware).
func CORSWith(cfg config.CORSConfig) gin.HandlerFunc {
	allowed := make(map[string]bool, len(cfg.AllowOrigins))
	for _, o := range cfg.AllowOrigins {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	methods := strings.Join(cfg.AllowMethods, ", ")
	if methods == "" {
		methods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	}
	headers := strings.Join(cfg.AllowHeaders, ", ")
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			if cfg.AllowCredentials {
				c.Header("Access-Control-Allow-Credentials", "true")
			}
			c.Header("Access-Control-Allow-Methods", methods)
			if headers != "" {
				c.Header("Access-Control-Allow-Headers", headers)
			}
			if len(cfg.ExposeHeaders) > 0 {
				c.Header("Access-Control-Expose-Headers", strings.Join(cfg.ExposeHeaders, ", "))
			}
			if cfg.MaxAgeSeconds > 0 {
				c.Header("Access-Control-Max-Age", strconv.Itoa(cfg.MaxAgeSeconds))
			}
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// BodyLimit caps request bodies at the transport layer.
func BodyLimit(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		}
		c.Next()
	}
}

// BodyLimitByPrefix caps request bodies per path prefix (longest match wins),
// so the one shared engine can honour each domain's payload budget.
func BodyLimitByPrefix(limits map[string]int64) gin.HandlerFunc {
	normalised := make(map[string]int64, len(limits))
	for prefix, limit := range limits {
		if p := strings.TrimSuffix(strings.TrimSpace(prefix), "/"); p != "" && limit > 0 {
			normalised[p] = limit
		}
	}
	return func(c *gin.Context) {
		limit := int64(0)
		bestLen := 0
		path := c.Request.URL.Path
		for prefix, candidate := range normalised {
			if (path == prefix || strings.HasPrefix(path, prefix+"/")) && len(prefix) > bestLen {
				bestLen, limit = len(prefix), candidate
			}
		}
		if limit > 0 && c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

// RequireUID extracts the APISIX forward-auth identity for a route group.
func RequireUID() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := CurrentUID(c); !ok {
			c.Abort()
			return
		}
		c.Next()
	}
}

// CurrentUID returns the gateway identity, writing 401 + abort when absent.
func CurrentUID(c *gin.Context) (int64, bool) {
	if v, ok := c.Get("uid"); ok {
		if uid, ok := v.(int64); ok && uid > 0 {
			return uid, true
		}
	}
	raw := strings.TrimSpace(c.GetHeader("X-Uid"))
	uid, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || uid <= 0 {
		Error(c, http.StatusUnauthorized, "未提供或无效的认证 token")
		c.Abort()
		return 0, false
	}
	c.Set("uid", uid)
	return uid, true
}

// InternalAuth guards /internal/* M2M endpoints with a shared service token in
// addition to the gateway key-auth (defence in depth). Fail-closed when the
// token is not configured.
func InternalAuth(token string) gin.HandlerFunc {
	token = strings.TrimSpace(token)
	return func(c *gin.Context) {
		if token == "" {
			slog.Error("[AUTH] internal api key is not configured; refusing M2M request")
			Error(c, http.StatusServiceUnavailable, "internal auth not configured")
			c.Abort()
			return
		}
		got := strings.TrimSpace(c.GetHeader("X-Internal-Key"))
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			Error(c, http.StatusUnauthorized, "invalid internal credentials")
			c.Abort()
			return
		}
		c.Next()
	}
}

// ── In-process rate limiting ─────────────────────────────────────────

type bucket struct {
	tokens float64
	last   time.Time
}

// RateLimiter is a token-bucket limiter keyed by IP (or IP+uid).
type RateLimiter struct {
	rps     float64
	burst   int
	keyMode string
	exclude map[string]bool
	mu      sync.Mutex
	buckets map[string]*bucket

	stopOnce sync.Once
	stop     chan struct{}
}

// NewRateLimiter builds a limiter; cleanup goroutine is started here.
func NewRateLimiter(cfg config.RateLimitConfig) *RateLimiter {
	l := &RateLimiter{
		rps: cfg.RPS, burst: cfg.Burst, keyMode: cfg.Key,
		exclude: map[string]bool{}, buckets: map[string]*bucket{},
		stop: make(chan struct{}),
	}
	for _, p := range cfg.ExcludePaths {
		l.exclude[p] = true
	}
	interval := time.Duration(cfg.CleanupIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-l.stop:
				return
			case <-t.C:
				l.mu.Lock()
				for k, b := range l.buckets {
					if time.Since(b.last) > 10*time.Minute {
						delete(l.buckets, k)
					}
				}
				l.mu.Unlock()
			}
		}
	}()
	return l
}

// Close stops the cleanup goroutine (idempotent; call on shutdown).
func (l *RateLimiter) Close() {
	if l == nil {
		return
	}
	l.stopOnce.Do(func() { close(l.stop) })
}

// Handler enforces the token bucket.
func (l *RateLimiter) Handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		for p := range l.exclude {
			if path == p || strings.HasPrefix(path, strings.TrimSuffix(p, "/")+"/") {
				c.Next()
				return
			}
		}
		key := c.ClientIP()
		if l.keyMode == "ip_uid" {
			if uid := strings.TrimSpace(c.GetHeader("X-Uid")); uid != "" {
				key += "|" + uid
			}
		}
		now := time.Now()
		l.mu.Lock()
		b, ok := l.buckets[key]
		if !ok {
			b = &bucket{tokens: float64(l.burst), last: now}
			l.buckets[key] = b
		}
		b.tokens += now.Sub(b.last).Seconds() * l.rps
		if b.tokens > float64(l.burst) {
			b.tokens = float64(l.burst)
		}
		b.last = now
		allowed := b.tokens >= 1
		if allowed {
			b.tokens--
		}
		l.mu.Unlock()
		if !allowed {
			c.Header("Retry-After", "1")
			Error(c, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
			c.Abort()
			return
		}
		c.Next()
	}
}

// Error writes the uniform {"detail": ...} envelope.
func Error(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}

// RespondError renders the shared apperr model (or a generic 500 for unknown
// errors, logging the cause). It returns true when it wrote a response.
// Structured details (apperr.Error.Meta) are rendered as {"detail": Meta}.
func RespondError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	var ae *apperr.Error
	if errors.As(err, &ae) {
		if ae.Status >= http.StatusInternalServerError {
			slog.ErrorContext(c.Request.Context(), "[HTTP] request failed",
				"code", ae.Code, "path", c.Request.URL.Path, "err", ae.Err)
		}
		if ae.Meta != nil {
			c.JSON(ae.Status, gin.H{"detail": ae.Meta})
			return true
		}
		Error(c, ae.Status, ae.Detail)
		return true
	}
	slog.ErrorContext(c.Request.Context(), "[HTTP] internal error",
		"path", c.Request.URL.Path, "err", err)
	Error(c, http.StatusInternalServerError, "服务异常，请稍后重试")
	return true
}

// JSONNotFound is the shared 404 fallback, installed as the engine's NoRoute.
func JSONNotFound(c *gin.Context) {
	Error(c, http.StatusNotFound, "接口不存在")
}

// JSONMethodNotAllowed is the shared 405 fallback, installed as NoMethod.
func JSONMethodNotAllowed(c *gin.Context) {
	Error(c, http.StatusMethodNotAllowed, "不支持的请求方法")
}

// BindJSON binds + validates a DTO (binding tags). Invalid input returns 400
// with a stable envelope; validation details are logged, never echoed raw.
func BindJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		slog.WarnContext(c.Request.Context(), "[HTTP] invalid request body",
			"path", c.Request.URL.Path, "err", err)
		Error(c, http.StatusBadRequest, "请求参数不合法")
		return false
	}
	return true
}
