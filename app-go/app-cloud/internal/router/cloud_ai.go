package router

// Cloud document intelligence endpoints: per-file summary (owner + M2M),
// folder-scoped semantic search and similar files, plus the KG document reads
// (listing + body text) that app-ts uses to build cloud-drive knowledge points.
//
// The owner endpoints read the gateway-injected X-Uid like every other
// /cloud/* route. The /internal/cloud/{summary,similar,kg/*} endpoints exist for
// service-to-service use (app-ts tools) and authenticate with the shared
// internal.api_key instead of a user session; an unconfigured key fails
// closed. The legacy /internal/cloud/reconcile endpoint keeps its own
// deployment posture and is deliberately not covered here.

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"unicode/utf8"

	"app-cloud/internal/dto"
	"app-cloud/internal/infra/mongostore"
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
	// KG cloud-document reads (app-ts → cloud-drive knowledge points). No
	// capability gate: a disabled Mongo store degrades to "no documents" /
	// 404 exactly like the other nil-safe Mongo readers.
	internal.GET("/kg/documents", KGDocumentsHandler(d.Mongo))
	internal.GET("/kg/document", KGDocumentHandler(d.Mongo))
	registerInternalAvatar(internal, d)
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

// ── machine-to-machine: KG cloud-document reads ─────────────────────

// KGDocumentReader is the read port over parsed drive documents used by the
// cloud knowledge-graph M2M face; *mongostore.MongoStore is the production
// implementation and stays nil-safe. The interface (and the two handler
// constructors below) are exported so the black-box HTTP suite can exercise
// the contract without a live MongoDB.
type KGDocumentReader interface {
	ListParsedDocuments(ctx context.Context, uid int64, afterUploadUUID string,
		limit int) ([]mongostore.ParsedDocumentMeta, error)
	GetParsedDocument(ctx context.Context, uid int64,
		uploadUUID string) (*mongostore.ParsedDocument, error)
}

const (
	// kgDocumentsDefaultLimit / kgDocumentsMaxLimit bound one listing page:
	// app-ts walks the drive in upload_uuid order and a page of IDs is cheap,
	// while 100 is the most the KG build orchestration should have to buffer.
	kgDocumentsDefaultLimit = 50
	kgDocumentsMaxLimit     = 100
	// kgDocumentMaxChars caps the body returned per document. One LLM
	// extraction window never needs more, and a runaway multi-MB text must not
	// bloat the M2M response. Counted in characters, like size_chars.
	kgDocumentMaxChars = 200_000
)

// KGDocumentsHandler — GET /internal/cloud/kg/documents?uid=&limit=&cursor=
// Lists the user's parsed documents (identity + content hash only, no body),
// ordered by upload_uuid; a full page returns the last uuid as next_cursor.
func KGDocumentsHandler(reader KGDocumentReader) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		limit := clampInt(c.DefaultQuery("limit", strconv.Itoa(kgDocumentsDefaultLimit)),
			1, kgDocumentsMaxLimit)
		cursor := trim(c.Query("cursor"))

		metas, err := reader.ListParsedDocuments(c.Request.Context(), uid, cursor, limit)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		items := make([]dto.KGDocumentsItem, 0, len(metas))
		for _, meta := range metas {
			items = append(items, dto.KGDocumentsItem{
				UploadUUID:  meta.UploadUUID,
				Title:       meta.Title,
				ContentHash: meta.ContentHash,
				SizeChars:   meta.SizeChars,
			})
		}
		// next_cursor is only meaningful when the page is full: a short page
		// proves there are no further upload_uuid values. A full page may still
		// be the last one — the next call then simply returns zero items.
		var nextCursor *string
		if len(metas) == limit {
			last := metas[len(metas)-1].UploadUUID
			nextCursor = &last
		}
		c.JSON(http.StatusOK, dto.KGDocumentsResponse{Items: items, NextCursor: nextCursor})
	}
}

// KGDocumentHandler — GET /internal/cloud/kg/document?uid=&upload_uuid=
// Returns one parsed document body (truncated to kgDocumentMaxChars) plus the
// content hash that versions it.
func KGDocumentHandler(reader KGDocumentReader) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := trim(c.Query("upload_uuid"))
		if uploadUUID == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少 upload_uuid 参数")
			return
		}
		doc, err := reader.GetParsedDocument(c.Request.Context(), uid, uploadUUID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if doc == nil {
			// Absent document or no usable body text — indistinguishable by
			// contract (the caller only needs "not extractable").
			apiErr(c, http.StatusNotFound, "Document not found")
			return
		}
		sizeChars := doc.SizeChars
		if sizeChars <= 0 {
			// Documents parsed before size_chars was persisted: compute the
			// exact count from the text we already loaded.
			sizeChars = utf8.RuneCountInString(doc.Text)
		}
		docUUID := doc.UploadUUID
		if docUUID == "" {
			docUUID = uploadUUID
		}
		c.JSON(http.StatusOK, dto.KGDocumentResponse{
			UploadUUID:  docUUID,
			Title:       doc.Title,
			ContentHash: doc.ContentHash,
			SizeChars:   sizeChars,
			Text:        truncateChars(doc.Text, kgDocumentMaxChars),
		})
	}
}

// truncateChars returns at most max characters (runes) of s. The limit counts
// characters, so byte slicing would both cut the budget short for CJK text and
// split a multi-byte rune into invalid UTF-8; walking rune boundaries avoids
// that without allocating a []rune copy of the whole text.
func truncateChars(s string, max int) string {
	if max <= 0 {
		return ""
	}
	seen := 0
	for idx := range s {
		if seen == max {
			return s[:idx]
		}
		seen++
	}
	return s
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
