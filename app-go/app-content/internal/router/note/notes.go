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

	notedto "app-content/internal/dto/note"
	"app-content/internal/middleware"
	"app-content/internal/service/note"

	"github.com/gin-gonic/gin"
)

func registerNotes(e *gin.Engine, svc *service.NoteService, internalAPIKey string) {
	g := e.Group("/notes")

	// Public sharing — declared before /:note_uuid so the static segment
	// wins (Gin prioritises static over param at the same level).
	g.GET("/shared/:share_token", func(c *gin.Context) {
		view, err := svc.GetSharedView(c.Request.Context(), c.Param("share_token"))
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "分享不存在或已失效")
				return
			}
			if errors.Is(err, service.ErrStorageUnavailable) {
				slog.Error("[NOTES] shared view storage unavailable", "err", err,
					"path", c.Request.URL.Path, "request_id", c.GetString("request_id"))
				apiErr(c, http.StatusServiceUnavailable, "存储暂不可用，请稍后重试")
				return
			}
			// Never leak driver/Mongo error text on a public endpoint.
			slog.Error("[NOTES] shared view internal error", "err", err,
				"path", c.Request.URL.Path, "request_id", c.GetString("request_id"))
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		c.JSON(http.StatusOK, toNoteShared(view))
	})

	g.GET("", listNotes(svc))
	g.POST("", createNote(svc))
	g.GET("/:note_uuid", getNote(svc))
	g.PATCH("/:note_uuid", updateNote(svc))
	g.DELETE("/:note_uuid", deleteNote(svc))
	g.POST("/:note_uuid/anchors", addAnchor(svc))
	g.DELETE("/:note_uuid/anchors/:anchor_id", deleteAnchor(svc))
	g.GET("/:note_uuid/revisions", listRevisions(svc))
	g.POST("/:note_uuid/revisions/restore/:revision_id", restoreRevision(svc))
	g.POST("/:note_uuid/share", createShare(svc))
	g.DELETE("/:note_uuid/share", revokeShare(svc))

	// M2M — consumed by the Python note agent tools (save_note etc.) via
	// APISIX key-auth; the caller forwards the authenticated uid explicitly.
	ig := e.Group("/internal/note", middleware.InternalAuth(internalAPIKey))
	ig.GET("/notes", listNotes(svc))
	ig.POST("/notes", createNote(svc))
	ig.GET("/notes/:note_uuid", getNote(svc))
	ig.PATCH("/notes/:note_uuid", updateNote(svc))
}

// ── Handlers ─────────────────────────────────────────────────────────

func createNote(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		var req notedto.CreateRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		detail, err := svc.CreateNote(c.Request.Context(), uid,
			req.Title, req.TargetType, req.TargetID, req.ContentMD)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusCreated, toNoteDetail(detail))
	}
}

func listNotes(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		page, pageSize := 1, 20
		if v := strings.TrimSpace(c.Query("page")); v != "" {
			n, perr := strconv.ParseInt(v, 10, 64)
			if perr != nil || n < 1 || n > 1000000 {
				apiErr(c, http.StatusBadRequest, "page must be 1-1000000")
				return
			}
			page = int(n)
		}
		if v := strings.TrimSpace(c.Query("page_size")); v != "" {
			n, perr := strconv.ParseInt(v, 10, 64)
			if perr != nil || n < 1 || n > 100 {
				apiErr(c, http.StatusBadRequest, "page_size must be 1-100")
				return
			}
			pageSize = int(n)
		}
		q := notedto.ListQuery{TargetType: strings.TrimSpace(c.Query("target_type")), TargetID: c.Query("target_id"), Page: page, PageSize: pageSize}
		if !q.Normalize() {
			apiErr(c, http.StatusBadRequest, "invalid target_type/target_id/page/page_size")
			return
		}
		notes, total, err := svc.ListNotes(c.Request.Context(), uid, q.TargetType, q.TargetID, q.Page, q.PageSize)
		if respondNoteErr(c, err) {
			return
		}
		c.Header("X-Total-Count", itoa(total))
		c.Header("Access-Control-Expose-Headers", "X-Total-Count")
		c.JSON(http.StatusOK, toNoteMetas(notes))
	}
}

func getNote(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		detail, err := svc.GetNote(c.Request.Context(), c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, toNoteDetail(detail))
	}
}

func updateNote(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		var req notedto.UpdateRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		ifMatch, err := parseIfMatch(c.GetHeader("If-Match"))
		if err != nil {
			apiErr(c, http.StatusBadRequest, "If-Match must be ISO-8601 datetime")
			return
		}
		detail, err := svc.UpdateNote(c.Request.Context(), c.Param("note_uuid"), uid,
			req.Title, req.ContentMD, req.IsPinned, ifMatch)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

func deleteNote(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		err := svc.DeleteNote(c.Request.Context(), c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func addAnchor(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		var req notedto.AnchorRequest
		if !middleware.BindJSON(c, &req) {
			return
		}
		view, err := svc.AddAnchor(c.Request.Context(), c.Param("note_uuid"), uid,
			req.BlockID, *req.Position, req.Label)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusCreated, toNoteAnchor(*view))
	}
}

func deleteAnchor(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		anchorID, err := strconv64(c.Param("anchor_id"))
		if err != nil {
			apiErr(c, http.StatusNotFound, "锚点不存在")
			return
		}
		err = svc.DeleteAnchor(c.Request.Context(), c.Param("note_uuid"), int(anchorID), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func listRevisions(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		revisions, err := svc.ListRevisions(c.Request.Context(), c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, toNoteRevisions(revisions))
	}
}

func restoreRevision(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		_, err := svc.RestoreRevision(c.Request.Context(),
			c.Param("note_uuid"), c.Param("revision_id"), uid)
		if respondNoteErr(c, err) {
			return
		}
		detail, err := svc.GetNote(c.Request.Context(), c.Param("note_uuid"), uid)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, detail)
	}
}

func createShare(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		var req notedto.ShareRequest
		if c.Request.Body != nil && c.Request.ContentLength != 0 {
			if !middleware.BindJSON(c, &req) {
				return
			}
		}
		view, err := svc.CreateShare(c.Request.Context(), c.Param("note_uuid"), uid, req.ExpiresInDays)
		if respondNoteErr(c, err) {
			return
		}
		c.JSON(http.StatusOK, toNoteShare(view))
	}
}

func revokeShare(svc *service.NoteService) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := middleware.CurrentUID(c)
		if !ok {
			return
		}
		err := svc.RevokeShare(c.Request.Context(), c.Param("note_uuid"), uid)
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
	// Storage unavailability keeps its dedicated 503/logging path (Mongo/MySQL
	// driver errors must never reach the client).
	if errors.Is(err, service.ErrStorageUnavailable) {
		slog.Error("[NOTES] storage unavailable", "err", err, "path", c.Request.URL.Path,
			"request_id", c.GetString("request_id"))
		apiErr(c, http.StatusServiceUnavailable, "存储暂不可用，请稍后重试")
		return true
	}
	// Everything else is an *apperr.Error (validation/conflict/not-found/...).
	return middleware.RespondError(c, err)
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
		// Upper bound: an unbounded page would overflow the OFFSET computation
		// and turn a client mistake into a driver error.
		if err != nil || n < 1 || n > 1_000_000 {
			apiErr(c, http.StatusBadRequest, "page must be 1-1000000")
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

// ── wire mappers (router -> dto; DTO has no service dependency) ───────

func toNoteMeta(m service.MetaView) notedto.Meta {
	return notedto.Meta{
		UUID:          m.UUID,
		Title:         m.Title,
		TargetType:    m.TargetType,
		TargetID:      m.TargetID,
		ContentLength: m.ContentLength,
		IsPinned:      m.IsPinned,
		RevisionCount: m.RevisionCount,
		CreatedAt:     service.FormatNaiveUTC(m.CreatedAt.Time),
		UpdatedAt:     service.FormatNaiveUTC(m.UpdatedAt.Time),
	}
}

func toNoteMetas(items []service.MetaView) []notedto.Meta {
	out := make([]notedto.Meta, 0, len(items))
	for _, m := range items {
		out = append(out, toNoteMeta(m))
	}
	return out
}

func toNoteDetail(d *service.NoteDetail) notedto.Detail {
	out := notedto.Detail{Meta: toNoteMeta(d.MetaView), ContentMD: d.ContentMD, Anchors: make([]notedto.Anchor, 0, len(d.Anchors))}
	for _, a := range d.Anchors {
		out.Anchors = append(out.Anchors, toNoteAnchor(a))
	}
	out.ShareToken = d.ShareToken
	if d.ShareExpiresAt != nil {
		v := service.FormatNaiveUTC(d.ShareExpiresAt.Time)
		out.ShareExpiresAt = &v
	}
	return out
}

func toNoteAnchor(a service.AnchorView) notedto.Anchor {
	return notedto.Anchor{
		ID: a.ID, BlockID: a.BlockID, Position: a.Position, Label: a.Label,
		CreatedAt: service.FormatNaiveUTC(a.CreatedAt.Time),
	}
}

func toNoteShare(s *service.ShareView) notedto.Share {
	out := notedto.Share{ShareToken: s.ShareToken, ShareURL: s.ShareURL}
	if s.ExpiresAt != nil {
		v := service.FormatNaiveUTC(s.ExpiresAt.Time)
		out.ExpiresAt = &v
	}
	return out
}

func toNoteRevisions(items []service.RevisionView) []notedto.Revision {
	out := make([]notedto.Revision, 0, len(items))
	for _, r := range items {
		out = append(out, notedto.Revision{
			RevisionID: r.RevisionID, RevisionNote: r.RevisionNote,
			CreatedAt: service.FormatNaiveUTC(r.CreatedAt.Time),
		})
	}
	return out
}

func toNoteShared(v *service.SharedView) notedto.Shared {
	return notedto.Shared{
		Title: v.Title, ContentMD: v.ContentMD, TargetType: v.TargetType,
		TargetID: v.TargetID, SharedAt: service.FormatNaiveUTC(v.SharedAt.Time),
		ViewCount: v.ViewCount,
	}
}
