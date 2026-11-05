package router

// Cloud document intelligence endpoints: per-file summary (owner + M2M),
// folder-scoped semantic search and similar files.
//
// The owner endpoints read the gateway-injected X-Uid like every other
// /cloud/* route. The /internal/cloud/{summary,similar} endpoints exist for
// service-to-service use (app-ts tools) and authenticate with the shared
// internal.api_key instead of a user session; an unconfigured key fails
// closed. The legacy /internal/cloud/reconcile endpoint keeps its own
// deployment posture and is deliberately not covered here.

import (
	"errors"
	"net/http"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerCloudAI mounts the owner-facing document intelligence endpoints on
// the /cloud group.
func registerCloudAI(g *gin.RouterGroup, d Deps) {
	g.GET("/video/:upload_uuid/summary", middleware.RequireCapability(d.Summary != nil, "摘要服务暂不可用"), getVideoSummary(d))
	g.GET("/video/:upload_uuid/similar", middleware.RequireCapability(d.Search != nil, "语义检索暂不可用"), getSimilarFiles(d))
	g.GET("/search/semantic", middleware.RequireCapability(d.Search != nil, "语义检索暂不可用"), searchSemantic(d))
}

// registerInternalCloudAI mounts the machine-to-machine endpoints.
func registerInternalCloudAI(e *gin.Engine, d Deps) {
	internal := e.Group("/internal/cloud")
	internal.Use(middleware.RequireInternalKey(d.Cfg), middleware.RequireInternalUID())
	internal.GET("/summary", middleware.RequireCapability(d.Summary != nil, "摘要服务暂不可用"), internalSummary(d))
	internal.GET("/similar", middleware.RequireCapability(d.Search != nil, "语义检索暂不可用"), internalSimilar(d))
}

// ── owner-facing ─────────────────────────────────────────────────────

// getVideoSummary — GET /cloud/video/{uuid}/summary
func getVideoSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		writeSummary(c, d, uid, c.Param("upload_uuid"))
	}
}

// searchSemantic — GET /cloud/search/semantic?q=&folderId=&limit=
func searchSemantic(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		q := trim(c.Query("q"))
		if q == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少搜索关键词 q")
			return
		}
		var folderID *int64
		if raw := trim(c.Query("folderId")); raw != "" {
			id, err := parseInt64(raw)
			if err != nil || id <= 0 {
				apiErr(c, http.StatusUnprocessableEntity, "folderId 不合法")
				return
			}
			folderID = &id
		}
		limit := clampInt(c.DefaultQuery("limit", "10"), 1, 20)
		results, err := d.Search.SearchSemantic(c.Request.Context(), uid, q, folderID, limit)
		if err != nil {
			if errors.Is(err, service.ErrSemanticUnavailable) {
				apiErr(c, http.StatusServiceUnavailable, "语义检索暂不可用")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		hits := semanticHits(results)
		c.JSON(http.StatusOK, dto.SemanticSearchResponse{
			Mode:    "semantic",
			Results: hits,
			Total:   len(hits),
		})
	}
}

// getSimilarFiles — GET /cloud/video/{uuid}/similar?limit=
func getSimilarFiles(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		limit := clampInt(c.DefaultQuery("limit", "5"), 1, 10)
		results, err := d.Search.Similar(c.Request.Context(), uid, c.Param("upload_uuid"), limit)
		if err != nil {
			switch {
			case errors.Is(err, service.ErrNotFound):
				apiErr(c, http.StatusNotFound, "File not found")
			case errors.Is(err, service.ErrSemanticUnavailable):
				apiErr(c, http.StatusServiceUnavailable, "语义检索暂不可用")
			default:
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			}
			return
		}
		c.JSON(http.StatusOK, dto.SimilarResponse{Items: semanticHits(results)})
	}
}

// ── machine-to-machine ───────────────────────────────────────────────

// internalSummary — GET /internal/cloud/summary?uid=&upload_uuid=
func internalSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := trim(c.Query("upload_uuid"))
		if uploadUUID == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少 upload_uuid 参数")
			return
		}
		writeSummary(c, d, uid, uploadUUID)
	}
}

// internalSimilar — GET /internal/cloud/similar?uid=&upload_uuid=&limit=
func internalSimilar(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := trim(c.Query("upload_uuid"))
		if uploadUUID == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少 upload_uuid 参数")
			return
		}
		limit := clampInt(c.DefaultQuery("limit", "5"), 1, 10)
		results, err := d.Search.Similar(c.Request.Context(), uid, uploadUUID, limit)
		if err != nil {
			switch {
			case errors.Is(err, service.ErrNotFound):
				apiErr(c, http.StatusNotFound, "File not found")
			case errors.Is(err, service.ErrSemanticUnavailable):
				apiErr(c, http.StatusServiceUnavailable, "语义检索暂不可用")
			default:
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			}
			return
		}
		c.JSON(http.StatusOK, dto.SimilarResponse{Items: semanticHits(results)})
	}
}

// ── shared helpers ───────────────────────────────────────────────────

// writeSummary answers the summary payload (available / stale / model /
// summary) for one owner-scoped file.
func writeSummary(c *gin.Context, d Deps, uid int64, uploadUUID string) {
	view, err := d.Summary.Get(c.Request.Context(), uid, uploadUUID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
		return
	}
	c.JSON(http.StatusOK, summaryResponse(view))
}

// summaryResponse maps the service read model onto the wire DTO.
func summaryResponse(view *service.SummaryView) dto.SummaryResponse {
	resp := dto.SummaryResponse{
		UploadUUID:   view.UploadUUID,
		OriginalName: view.OriginalName,
		Title:        view.Title,
		Available:    view.Available,
		Stale:        view.Stale,
		Model:        view.Model,
	}
	if view.Summary == nil {
		return resp
	}
	resp.Summary = &dto.Summary{
		Overview:         view.Summary.Overview,
		Topics:           stringsOrEmpty(view.Summary.Topics),
		Entities:         stringsOrEmpty(view.Summary.Entities),
		KeyPoints:        stringsOrEmpty(view.Summary.KeyPoints),
		Todos:            stringsOrEmpty(view.Summary.Todos),
		AnswersQuestions: stringsOrEmpty(view.Summary.AnswersQuestions),
		Language:         view.Summary.Language,
		SizeChars:        view.Summary.SizeChars,
	}
	return resp
}

// semanticHits maps ranked service results onto the wire DTO.
func semanticHits(results []service.SemanticResult) []dto.SemanticHit {
	hits := make([]dto.SemanticHit, 0, len(results))
	for _, r := range results {
		hits = append(hits, dto.SemanticHit{
			UploadUUID:   r.UploadUUID,
			OriginalName: r.OriginalName,
			Title:        r.Title,
			MimeType:     r.MimeType,
			FileSize:     r.FileSize,
			Score:        r.Score,
			Snippets:     stringsOrEmpty(r.Snippets),
		})
	}
	return hits
}

// stringsOrEmpty keeps list fields as [] instead of null on the wire.
func stringsOrEmpty(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}
