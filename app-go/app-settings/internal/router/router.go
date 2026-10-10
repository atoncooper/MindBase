// Package router — app-settings HTTP surface: /preferences + /wallpaper/*.
// Per-user API key configuration (BYOK credentials, embedding/asr configs)
// was retired: all AI traffic runs on the platform gateway, so the service no
// longer serves /settings/* or /credentials (404 via NoRoute).
// Identity = gateway-injected X-Uid; error body = {"detail": ...}.
package router

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-settings/internal/config"
	"app-settings/internal/db"
	"app-settings/internal/logger"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Deps carries the wired dependencies. MySQL access goes through the db
// package functions/global (initialized by db.Init at boot).
type Deps struct {
	Cfg *config.Config
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil)
	e.Use(logger.GinRecovery(), requestID(), logger.GinLogger(), securityHeaders(), cors())

	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-settings"}
		code := http.StatusOK
		if db.DB != nil {
			pingCtx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := db.DB.WithContext(pingCtx).Exec("select 1").Error; err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		c.JSON(code, body)
	})

	registerPreferences(e)
	registerWallpaper(e)
	registerAvatar(e)

	e.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "接口不存在"})
	})
	e.NoMethod(func(c *gin.Context) {
		c.JSON(http.StatusMethodNotAllowed, gin.H{"detail": "不支持的请求方法"})
	})
	e.HandleMethodNotAllowed = true
	return e
}

// ── helpers ──────────────────────────────────────────────────────────

// currentUID reads the gateway-injected X-Uid. Missing/invalid → 401.
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

func cors() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

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

func apiErr(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}
