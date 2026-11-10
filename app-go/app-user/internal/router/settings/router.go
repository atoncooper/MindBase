// Package router — settings-domain HTTP surface: /preferences + /avatar/* and
// the Coding Plan user/M2M faces (/settings/coding-plans,
// /internal/settings/coding-plan/{uid}).
// Per-user API key configuration (BYOK credentials, embedding/asr configs)
// was retired: all AI traffic runs on the platform gateway.
// Identity = gateway-injected X-Uid; error body = {"detail": ...}.
package router

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-user/internal/config"
	"app-user/internal/router/middleware"
	settingsservice "app-user/internal/service/settings"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired dependencies. MySQL access goes through the db
// package functions/global (initialized by db.Init at boot).
type Deps struct {
	Cfg *config.SettingsConfig
	Svc *settingsservice.Service
	// CodingPlans owns Coding Plan CRUD + the VIP/SVIP gate (settings domain).
	CodingPlans *settingsservice.CodingPlanService
	// InternalAPIKey guards the M2M face (/internal/settings/coding-plan/{uid}).
	// Main passes the shared APISIX consumer key from the auth config.
	InternalAPIKey string
}

// settingsSvc is the package-level settings service (nil in offline tests).
var settingsSvc *settingsservice.Service

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	settingsSvc = d.Svc
	e := gin.New()
	e.SetTrustedProxies(d.Cfg.Server.TrustedProxies)
	e.Use(middleware.Recovery(), middleware.RequestID(), middleware.Metrics("settings"), middleware.AccessLog(), middleware.SecurityHeaders(), middleware.BodyLimit(maxBodyBytes(d.Cfg.Server.MaxBodyBytes, 4<<20)), middleware.CORS(nil))

	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-settings"}
		code := http.StatusOK
		if d.Svc != nil {
			pingCtx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := d.Svc.Ping(pingCtx); err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		c.JSON(code, body)
	})

	registerPreferences(e)
	registerAvatar(e)
	registerCodingPlans(e, d)

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

func apiErr(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}

func maxBodyBytes(configured, fallback int) int64 {
	if configured > 0 {
		return int64(configured)
	}
	return int64(fallback)
}
