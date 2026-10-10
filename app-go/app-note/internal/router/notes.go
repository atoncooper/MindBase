// Notes endpoints — port of app/routers/notes.py. Cross-user access returns
// 404 (not 403) to avoid leaking note existence; /notes/shared/{token} is
// public.
package router

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-note/internal/repo"
	"app-note/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func registerNotes(e *gin.Engine, svc *service.NoteService, db *gorm.DB) {
	g := e.Group("/notes")

	// Public sharing — declared before /:note_uuid so the static segment
	// wins (Gin prioritises static over param at the same level).
	g.GET("/shared/:share_token", func(c *gin.Context) {
		view, err := svc.GetSharedView(c.Request.Context(), db, c.Param("share_token"))
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "分享不存在或已失效")
				return
			}
			apiErr(c, http.StatusInternalServerError, err.Error())
			return
		}
		c.JSON(http.StatusOK, view)
	})

	g.GET("", listNotes(svc, db))
	g.POST("", createNote(svc, db))
	g.GET("/:note_uuid", getNote(svc, db))
	g.PATCH("/:note_uuid", updateNote(svc, db))
	g.DELETE("/:note_uuid", deleteNote(svc, db))
	g.POST("/:note_uuid/anchors", addAnchor(svc, db))
	g.DELETE("/:note_uuid/anchors/:anchor_id", deleteAnchor(svc, db))
	g.GET("/:note_uuid/revisions", listRevisions(svc, db))
	g.POST("/:note_uuid/revisions/restore/:revision_id", restoreRevision(svc, db))
	g.POST("/:note_uuid/share", createShare(svc, db))
	g.DELETE("/:note_uuid/share", revokeShare(svc, db))

	// M2M — consumed by the Python note agent tools (save_note etc.) via
	// APISIX key-auth; the caller forwards the authenticated uid explicitly.
	ig := e.Group("/internal/note")
	ig.GET("/notes", listNotes(svc, db))
	ig.POST("/notes", createNote(svc, db))
	ig.GET("/notes/:note_uuid", getNote(svc, db))
	ig.PATCH("/notes/:note_uuid", updateNote(svc, db))
}

// ── Handlers ─────────────────────────────────────────────────────────

type createReq struct {
	Title      string `json:"title"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	ContentMD  string `json:"content_md"`
}

func createNote(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req createReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if req.TargetType == "" || req.TargetID == "" {
			apiErr(c, http.StatusBadRequest, "target_type and target_id are required")
			return
		}
		if len(req.TargetID) > 100 {
			apiErr(c, http.StatusBadRequest, "target_id must be at most 100 characters")
			return
		}
		if len(req.Title) > 500 {
			apiErr(c, http.StatusBadRequest, "title must be at most 500 characters")
			return
		}
		if len(req.ContentMD) > 512*1024 {
			apiErr(c, http.StatusBadRequest, "content_md exceeds 512 KB")
			return
		}
		detail, err := svc.CreateNote(c.Request.Context(), db, uid,
			req.Title, req.TargetType, req.TargetID, req.ContentMD)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusCreated, detail)
	}
}

func listNotes(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		targetType := c.Query("target_type")
		if targetType != "" && targetType != "video" && targetType != "cloud_file" {
			apiErr(c, http.StatusBadRequest, "invalid target_type")
			return
		}
		targetID := c.Query("target_id")
		if len(targetID) > 100 {
			apiErr(c, http.StatusBadRequest, "target_id must be at most 100 characters")
			return
		}
		page, pageSize, ok := pagination(c)
		if !ok {
			return
		}
		notes, total, err := svc.ListNotes(c.Request.Context(), db, uid, targetType, targetID, page, pageSize)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, err.Error())
			return
		}
		out := make([]service.MetaView, 0, len(notes))
		for _, n := range notes {
			out = append(out, service.MetaView{
				UUID: n.UUID, Title: n.Title, TargetType: n.TargetType, TargetID: n.TargetID,
				ContentLength: n.ContentLength, IsPinned: n.IsPinned, RevisionCount: n.RevisionCount,
				CreatedAt: service.NaiveUTC{Time: n.CreatedAt}, UpdatedAt: service.NaiveUTC{Time: n.UpdatedAt},
			})
		}
		c.Header("X-Total-Count", itoa(total))
		c.Header("Access-Control-Expose-Headers", "X-Total-Count")
		c.JSON(http.StatusOK, out)
	}
}

func getNote(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		detail, err := svc.GetNote(c.Request.Context(), db, c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

type updateReq struct {
	Title     *string `json:"title"`
	ContentMD *string `json:"content_md"`
	IsPinned  *bool   `json:"is_pinned"`
}

func updateNote(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req updateReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		ifMatch, err := parseIfMatch(c.GetHeader("If-Match"))
		if err != nil {
			apiErr(c, http.StatusBadRequest, "If-Match must be ISO-8601 datetime")
			return
		}
		if req.Title != nil && len(*req.Title) > 500 {
			apiErr(c, http.StatusBadRequest, "title must be at most 500 characters")
			return
		}
		if req.ContentMD != nil && len(*req.ContentMD) > 512*1024 {
			apiErr(c, http.StatusBadRequest, "content_md exceeds 512 KB")
			return
		}
		detail, err := svc.UpdateNote(c.Request.Context(), db, c.Param("note_uuid"), uid,
			req.Title, req.ContentMD, req.IsPinned, ifMatch)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

func deleteNote(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		err := svc.DeleteNote(c.Request.Context(), db, c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

type anchorReq struct {
	BlockID  string  `json:"block_id"`
	Position *int    `json:"position"`
	Label    *string `json:"label"`
}

func addAnchor(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req anchorReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if req.BlockID == "" || len(req.BlockID) > 50 {
			apiErr(c, http.StatusBadRequest, "block_id must be 1-50 characters")
			return
		}
		if req.Position == nil || *req.Position < 0 {
			apiErr(c, http.StatusBadRequest, "position must be >= 0")
			return
		}
		if req.Label != nil && len(*req.Label) > 200 {
			apiErr(c, http.StatusBadRequest, "label must be at most 200 characters")
			return
		}
		view, err := svc.AddAnchor(c.Request.Context(), db, c.Param("note_uuid"), uid,
			req.BlockID, *req.Position, req.Label)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusCreated, view)
	}
}

func deleteAnchor(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		anchorID, err := strconv64(c.Param("anchor_id"))
		if err != nil {
			apiErr(c, http.StatusNotFound, "锚点不存在")
			return
		}
		err = svc.DeleteAnchor(c.Request.Context(), db, c.Param("note_uuid"), int(anchorID), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func listRevisions(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		revisions, err := svc.ListRevisions(c.Request.Context(), db, c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, revisions)
	}
}

func restoreRevision(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		_, err := svc.RestoreRevision(c.Request.Context(), db,
			c.Param("note_uuid"), c.Param("revision_id"), uid)
		if respondNoteErr(c, err) {
			return
		}
		detail, err := svc.GetNote(c.Request.Context(), db, c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

type shareReq struct {
	ExpiresInDays *int `json:"expires_in_days"`
}

func createShare(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req shareReq
		if c.Request.Body != nil && c.Request.ContentLength != 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				apiErr(c, http.StatusBadRequest, err.Error())
				return
			}
		}
		if req.ExpiresInDays != nil && (*req.ExpiresInDays < 1 || *req.ExpiresInDays > 365) {
			apiErr(c, http.StatusBadRequest, "expires_in_days must be 1-365")
			return
		}
		view, err := svc.CreateShare(c.Request.Context(), db, c.Param("note_uuid"), uid, req.ExpiresInDays)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, view)
	}
}

func revokeShare(svc *service.NoteService, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		err := svc.RevokeShare(c.Request.Context(), db, c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

// respondNoteErr maps service errors to the wire contract. Returns true
// when a response was written. Internal errors are logged but never leaked
// to the client; storage failures map to 503 (retryable).
func respondNoteErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	var conflict *service.ConflictError
	var validation *service.ValidationError
	log := slog.Error
	switch {
	case errors.As(err, &conflict):
		c.JSON(http.StatusConflict, gin.H{"detail": gin.H{
			"error":             "conflict",
			"note_uuid":         conflict.NoteUUID,
			"server_updated_at": service.FormatNaiveUTC(conflict.ServerUpdateAt),
		}})
	case errors.As(err, &validation):
		apiErr(c, http.StatusBadRequest, validation.Msg)
	case errors.Is(err, service.ErrNotFound):
		apiErr(c, http.StatusNotFound, "笔记不存在")
	case errors.Is(err, repo.ErrStorageUnavailable):
		log("[NOTES] storage unavailable", "err", err, "path", c.Request.URL.Path,
			"request_id", c.GetString("request_id"))
		apiErr(c, http.StatusServiceUnavailable, "存储暂不可用，请稍后重试")
	default:
		log("[NOTES] internal error", "err", err, "path", c.Request.URL.Path,
			"request_id", c.GetString("request_id"))
		apiErr(c, http.StatusInternalServerError, "内部错误")
	}
	return true
}

// parseIfMatch parses the If-Match header (ISO-8601, tolerant of a trailing
// 'Z') into a UTC time. nil when the header is absent.
func parseIfMatch(raw string) (*time.Time, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	t, err := service.ParseUTC(raw)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func pagination(c *gin.Context) (int, int, bool) {
	page, pageSize := 1, 20
	if v := c.Query("page"); v != "" {
		n, err := strconv64(v)
		if err != nil || n < 1 {
			apiErr(c, http.StatusBadRequest, "page must be >= 1")
			return 0, 0, false
		}
		page = int(n)
	}
	if v := c.Query("page_size"); v != "" {
		n, err := strconv64(v)
		if err != nil || n < 1 || n > 100 {
			apiErr(c, http.StatusBadRequest, "page_size must be 1-100")
			return 0, 0, false
		}
		pageSize = int(n)
	}
	return page, pageSize, true
}

func strconv64(s string) (int64, error) {
	return strconv.ParseInt(strings.TrimSpace(s), 10, 64)
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}
