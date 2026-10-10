// Package router assembles the Gin engine: middleware chain, health probe,
// and the acquisition endpoints (favorites / knowledge build / asr).
// Identity = gateway-injected X-Uid (parity with the other services).
//
// Wire contract: responses mirror the Python FastAPI shapes field-for-field
// (snake_case keys, same status codes and Chinese detail messages) so the
// frontend client needs zero changes.
package router

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-bili/internal/config"
	"app-bili/internal/logger"
	"app-bili/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg      *config.Config
	DB       *gorm.DB
	Fav      *service.FavoriteService
	ASR      *service.ASRPageService
	Build    *service.BuildService
	Scope    *service.KnowledgeScopeService
	Pages    *service.VideoPagesService
	Resolver service.Resolver // bili.CredentialResolver
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil)
	e.Use(logger.GinRecovery(), requestID(), logger.GinLogger(), securityHeaders(), cors(d.Cfg))

	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-bili"}
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

	registerFavorites(e, d)
	registerKnowledge(e, d)
	registerASR(e, d)
	registerInternal(e, d)

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
// plugin) or mints one; access logs carry it for trail correlation.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader("X-Request-Id"))
		if id == "" {
			id = strings.ReplaceAll(newUUID(), "-", "")[:12]
		}
		if len(id) > 64 {
			id = id[:64]
		}
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

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

// writeJSON marshals with the NaiveUTC time format registered via the
// map/set fields the services already produced.
func writeJSON(c *gin.Context, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		apiErr(c, http.StatusInternalServerError, "内部错误")
		return
	}
	c.Data(status, "application/json; charset=utf-8", raw)
}

func newUUID() string { return uuid.NewString() }

// serviceErr maps service errors onto the wire contract (HTTPError carries
// its status; everything else is a 500 with a non-leaking detail).
func serviceErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	var he *service.HTTPError
	if isHTTPError(err, &he) {
		apiErr(c, he.Status, he.Message)
		return true
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": "内部错误"})
	return true
}

func isHTTPError(err error, target **service.HTTPError) bool {
	for err != nil {
		if e, ok := err.(*service.HTTPError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
