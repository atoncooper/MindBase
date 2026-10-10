// Package router assembles the Gin engine: middleware chain, health probe,
// the /notes/* user endpoints, and the /internal/note/* M2M endpoints.
// Identity source = the gateway-injected X-Uid header (APISIX forward-auth
// against app-auth for user routes; key-auth + explicit X-Uid for the M2M
// routes called by the Python note agent). Parity with the Python backend's
// post-cutover contract.
package router

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-note/internal/config"
	"app-note/internal/logger"
	"app-note/internal/repo"
	"app-note/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg     *config.Config
	DB      *gorm.DB
	Content service.ContentStore // Mongo-backed content/revisions repo
	Notes   *service.NoteService
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil)
	e.Use(logger.GinRecovery(), requestID(), logger.GinLogger(), securityHeaders(), cors(d.Cfg))

	// Health probe — APISIX active checks hit this. MySQL unreachable →
	// 503 so the gateway pulls the node; Mongo down does NOT fail the
	// probe (reads degrade, writes fail per-request — same semantics as
	// the Python backend).
	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-note"}
		code := http.StatusOK
		if d.DB != nil {
			pingCtx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := d.DB.WithContext(pingCtx).Exec("select 1").Error; err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		c.JSON(code, body)
	})

	if d.Notes == nil {
		d.Notes = service.NewNoteService(repo.NewNoteRepo(), d.Content)
	}
	registerNotes(e, d.Notes, d.DB)

	// Unknown paths / methods answer with the same {"detail": ...} shape as
	// the endpoint errors (parity with the FastAPI error body the frontend
	// and M2M callers parse), instead of gin's empty-text 404.
	e.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "接口不存在"})
	})
	e.NoMethod(func(c *gin.Context) {
		c.JSON(http.StatusMethodNotAllowed, gin.H{"detail": "不支持的请求方法"})
	})
	e.HandleMethodNotAllowed = true
	return e
}

// requestID propagates the gateway-generated request id (APISIX request-id
// plugin) or mints one, so access logs correlate with the gateway trail.
// Exposed on the response as X-Request-Id.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader("X-Request-Id"))
		if id == "" {
			id = uuid.NewString()
		}
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

// currentUID reads the gateway-injected X-Uid. Missing/invalid → 401.
// Client-supplied X-Uid is stripped/overwritten by the gateway
// (proxy-rewrite / auth_request_set), never trusted from the wire.
func currentUID(c *gin.Context) (int64, bool) {
	raw := strings.TrimSpace(c.Request.Header.Get("X-Uid"))
	if raw == "" {
		apiErr(c, http.StatusUnauthorized, "未提供认证 token")
		return 0, false
	}
	uid, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || uid <= 0 {
		apiErr(c, http.StatusUnauthorized, "token 无效或已过期")
		return 0, false
	}
	return uid, true
}

func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

func cors(cfg *config.Config) gin.HandlerFunc {
	allowed := make(map[string]bool, len(cfg.CORS.AllowOrigins))
	for _, o := range cfg.CORS.AllowOrigins {
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
			c.Header("Access-Control-Expose-Headers", "X-Total-Count")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func apiErr(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}
