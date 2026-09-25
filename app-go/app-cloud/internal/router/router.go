// Package router assembles the Gin engine: middleware chain, health probe,
// and the /cloud/* user endpoints. Identity source = the gateway-injected
// X-Uid header (nginx auth_request against app-auth; parity with the
// Python backend's post-cutover contract).
package router

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"app-cloud/internal/config"
	"app-cloud/internal/logger"
	"app-cloud/internal/minio"
	"app-cloud/internal/mongostore"
	"app-cloud/internal/repo"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Cfg        *config.Config
	DB         *gorm.DB
	Minio      *minio.Client
	Quota      *service.QuotaService
	Upload     *service.UploadService
	Process    *service.Pipeline // nil = pipeline disabled
	Purge      *service.PurgeService
	Mongo      *mongostore.MongoStore
	Files      *repo.FileRepo
	Folders    *repo.FolderRepo
	Share      *service.ShareService
	Reconciler *service.Reconciler
}

// ASRPreview proxies the Mongo store (nil-safe).
func (d Deps) ASRPreview(ctx context.Context, uploadUUID string) string {
	return d.Mongo.ASRPreview(ctx, uploadUUID, 20000)
}

// DocumentPreview proxies the Mongo store (nil-safe).
func (d Deps) DocumentPreview(ctx context.Context, uid int64, uploadUUID string, offset, limit int) (string, int, map[string]any) {
	return d.Mongo.DocumentPreview(ctx, uid, uploadUUID, offset, limit)
}

// New builds the engine.
func New(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.SetTrustedProxies(nil)
	e.Use(logger.GinRecovery(), logger.GinLogger(), securityHeaders(), cors(d.Cfg))

	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "app-cloud"})
	})

	registerCloud(e, d)
	return e
}

// currentUID reads the gateway-injected X-Uid (nginx auth_request → app-auth
// verify). Missing/invalid → 401. Client-supplied X-Uid is overwritten by
// nginx (auth_request_set), never trusted from the wire.
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
		c.Header("X-Frame-Options", "SAMEORIGIN") // SAMEORIGIN: presigned previews render in-app
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
