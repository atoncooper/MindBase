// Package router assembles the Gin engine: middleware chain, health probe,
// and the acquisition endpoints (favorites / knowledge build / asr).
// Identity = gateway-injected X-Uid (parity with the other services).
//
// Wire contract: responses mirror the Python FastAPI shapes field-for-field
// (snake_case keys, same status codes and Chinese detail messages) so the
// frontend client needs zero changes.
package router

import (
	"app-user/internal/utils"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-user/internal/config"
	"app-user/internal/router/middleware"
	"app-user/internal/service/bili"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg    *config.BiliConfig
	Health func(ctx context.Context) error
	// RedisHealth is optional (events/credential/rate-limit degradation), so
	// it is reported in the body but does not fail readiness.
	RedisHealth func(ctx context.Context) error
	Fav         *service.FavoriteService
	ASR         *service.ASRPageService
	Build       *service.BuildService
	Scope       *service.KnowledgeScopeService
	Pages       *service.VideoPagesService
	Resolver    service.Resolver // bili.CredentialResolver
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(d.Cfg.Server.TrustedProxies)
	e.Use(middleware.Recovery(), middleware.RequestID(), middleware.Metrics("bili"), middleware.AccessLog(), middleware.SecurityHeaders(), middleware.BodyLimit(maxBodyBytes(d.Cfg.Server.MaxBodyBytes, 1<<20)), middleware.CORS(d.Cfg.CORS.AllowOrigins))

	e.GET("/health", func(c *gin.Context) {
		body := gin.H{"status": "ok", "service": "app-user"}
		code := http.StatusOK
		if d.Health != nil {
			pingCtx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			if err := d.Health(pingCtx); err != nil {
				body["status"] = "degraded"
				body["mysql"] = "down"
				code = http.StatusServiceUnavailable
			}
			cancel()
		}
		if d.RedisHealth != nil {
			pingCtx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
			if err := d.RedisHealth(pingCtx); err != nil {
				body["redis"] = "down"
			} else {
				body["redis"] = "ok"
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

// serviceErr maps service errors onto the wire contract (HTTPError carries
// its status; everything else is a 500 with a non-leaking detail).
func serviceErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	var he *utils.HTTPError
	if isHTTPError(err, &he) {
		apiErr(c, he.Status, he.Message)
		return true
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": "内部错误"})
	return true
}

func isHTTPError(err error, target **utils.HTTPError) bool {
	for err != nil {
		if e, ok := err.(*utils.HTTPError); ok {
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

func maxBodyBytes(configured, fallback int) int64 {
	if configured > 0 {
		return int64(configured)
	}
	return int64(fallback)
}
