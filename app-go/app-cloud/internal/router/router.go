// Package router assembles the Gin engine: middleware chain, health probe,
// and the /cloud/* user endpoints. Identity source = the gateway-injected
// X-Uid header (nginx auth_request against app-auth; parity with the
// Python backend's post-cutover contract).
package router

import (
	"context"
	"net/http"

	"app-cloud/internal/config"
	"app-cloud/internal/dto"
	"app-cloud/internal/infra/minio"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/logger"
	"app-cloud/internal/metrics"
	"app-cloud/internal/middleware"
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
	Ref        *service.RefService // 1.0.16 — "save to my drive" references
	Attestor   *service.DeviceAttestor
	Reconciler *service.Reconciler
	// Summary / Search serve the document-intelligence read endpoints; nil
	// means the corresponding capability is unavailable (503).
	Summary *service.SummaryService
	Search  *service.SearchService
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
	e.Use(logger.GinRecovery(), logger.GinLogger(), middleware.SecurityHeaders(), middleware.CORS(d.Cfg))

	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, dto.HealthResponse{Status: "ok", Service: "app-cloud"})
	})
	// Prometheus exposition — cluster-internal only (nginx routes no /metrics).
	e.GET("/metrics", gin.WrapH(metrics.Handler()))
	e.Use(middleware.Metrics())

	registerCloud(e, d)
	registerWorkspaces(e, d)
	registerInternalCloudAI(e, d)
	return e
}

func apiErr(c *gin.Context, status int, detail string) {
	c.JSON(status, dto.ErrorResponse{Detail: detail})
}
