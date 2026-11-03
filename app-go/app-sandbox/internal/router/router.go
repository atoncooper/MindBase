// Package router is the app-sandbox HTTP surface (Gin):
//
//	POST   /v1/executions            create an execution (202)
//	GET    /v1/executions/:id        poll status/result
//	GET    /v1/executions/:id/events SSE stream
//	POST   /v1/executions/:id/cancel cancel (204, idempotent)
//	GET    /internal/leases          list leases (admin)
//	DELETE /internal/leases/:id      force release
//	GET    /health /ready /metrics
//
// Auth: /v1 and /internal require the shared gateway consumer key (X-API-Key or
// apikey); /v1 additionally requires the gateway-injected X-Uid. Identity never
// comes from the request body. Errors use the repo-wide {"detail": ...} shape.
package router

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"app-sandbox/internal/config"
	"app-sandbox/internal/logger"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Deps carries the wired dependencies of the HTTP layer.
type Deps struct {
	Cfg         *config.Config
	Executions  *service.ExecutionService
	Leases      *service.LeaseManager
	Metrics     *metrics.Metrics
	RuntimeName string
	// Admin serves the internal admin API (/internal/admin/*, X-Admin-Token).
	Admin *service.AdminService
	// PingDB reports database readiness for /ready (nil = skip the check).
	PingDB func(ctx context.Context) error
	// RuntimeProbe reports sandbox-backend readiness for /ready (nil = skip).
	RuntimeProbe func(ctx context.Context) error
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil)
	e.Use(logger.GinRecovery(), requestID(), logger.GinLogger(), securityHeaders())
	e.HandleMethodNotAllowed = true

	registerOps(e, d)
	registerAdmin(e, d)
	registerInternal(e.Group("/internal", apiKeyAuth(d.Cfg)), d)
	registerExecutions(e.Group("/v1", apiKeyAuth(d.Cfg), requireUID), d)

	e.NoRoute(func(c *gin.Context) { apiErr(c, http.StatusNotFound, "接口不存在") })
	e.NoMethod(func(c *gin.Context) { apiErr(c, http.StatusMethodNotAllowed, "不支持的请求方法") })
	return e
}

// ── middleware ───────────────────────────────────────────────────────

func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader("X-Request-Id"))
		if !validRequestID(id) {
			id = uuid.NewString()
		}
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

// validRequestID bounds the caller-supplied id so it always fits the audit
// column and cannot inject control characters into logs.
func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		ch := id[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' || ch == ':' {
			continue
		}
		return false
	}
	return true
}

func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// apiKeyAuth enforces the shared gateway consumer key. An unconfigured key fails
// closed (401) so a misconfigured deployment cannot expose the control plane.
func apiKeyAuth(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		expected := strings.TrimSpace(cfg.Auth.APIKey)
		if expected == "" {
			apiErr(c, http.StatusUnauthorized, "服务未配置 API Key")
			c.Abort()
			return
		}
		provided := strings.TrimSpace(c.GetHeader("X-API-Key"))
		if provided == "" {
			provided = strings.TrimSpace(c.GetHeader("apikey"))
		}
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			apiErr(c, http.StatusUnauthorized, "无效的 API Key")
			c.Abort()
			return
		}
		c.Next()
	}
}

// requireUID parses the gateway-injected X-Uid; identity never comes from the body.
func requireUID(c *gin.Context) {
	raw := strings.TrimSpace(c.GetHeader("X-Uid"))
	if raw == "" {
		apiErr(c, http.StatusUnauthorized, "未提供 X-Uid")
		c.Abort()
		return
	}
	uid, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || uid <= 0 {
		apiErr(c, http.StatusUnauthorized, "X-Uid 无效")
		c.Abort()
		return
	}
	c.Set("uid", uid)
	c.Next()
}

func currentUID(c *gin.Context) int64 {
	if v, ok := c.Get("uid"); ok {
		if uid, ok := v.(int64); ok {
			return uid
		}
	}
	return 0
}

func currentRequestID(c *gin.Context) string { return c.GetString("request_id") }

// ── error mapping ────────────────────────────────────────────────────

func apiErr(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}

// respondError maps domain errors onto the HTTP contract:
//   - validation            -> 400
//   - not found / foreign   -> 404 (never leak another tenant's ids)
//   - quota                 -> 429 {detail, kind, resetAt, tier, upgradeSku}
//   - admission queue full  -> 503
//   - admission queue timed out -> 429
//   - anything else         -> 500
func respondError(c *gin.Context, err error) {
	var quotaErr *service.QuotaExceededError
	switch {
	case errors.As(err, &quotaErr):
		c.JSON(http.StatusTooManyRequests, gin.H{
			"detail":     quotaErr.Error(),
			"kind":       quotaErr.Kind,
			"limit":      quotaErr.Limit,
			"used":       quotaErr.Used,
			"resetAt":    quotaErr.ResetAt,
			"tier":       quotaErr.Tier,
			"upgradeSku": quotaErr.UpgradeSKU(),
		})
	case errors.Is(err, service.ErrValidation):
		apiErr(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrNotFound), errors.Is(err, service.ErrForbidden):
		apiErr(c, http.StatusNotFound, "执行记录或租约不存在")
	case errors.Is(err, service.ErrQueueFull):
		c.JSON(http.StatusServiceUnavailable, gin.H{"detail": "沙箱执行队列已满，请稍后重试", "kind": "sandbox_queue"})
	case errors.Is(err, service.ErrQueueTimeout):
		c.JSON(http.StatusTooManyRequests, gin.H{"detail": "沙箱执行排队超时，请稍后重试", "kind": "sandbox_queue"})
	case errors.Is(err, context.Canceled):
		apiErr(c, http.StatusRequestTimeout, "请求已取消")
	case errors.Is(err, context.DeadlineExceeded):
		apiErr(c, http.StatusGatewayTimeout, "请求超时")
	default:
		slog.Error("[HTTP] unhandled error", "path", c.FullPath(), "err", err)
		apiErr(c, http.StatusInternalServerError, "内部错误")
	}
}
