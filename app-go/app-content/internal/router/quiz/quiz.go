// Quiz endpoints — port of the storage-face slice of app/routers/quiz.py:
// history, wrong-answer notebook, export, detail, delete and sharing.
// generate / generate-from-summary / submit stay in the Python backend
// (AI-bearing flows).
package router

import (
	quizdto "app-content/internal/dto/quiz"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"app-content/internal/middleware"
	"app-content/internal/service/quiz"
	"app-content/internal/service/quiz/exampaper"

	"github.com/gin-gonic/gin"
)

func registerQuiz(e *gin.Engine, svc *service.Store) {
	g := e.Group("/quiz")

	// Public sharing — declared before /:quiz_uuid so the static segment
	// wins (Gin prioritises static over param at the same level). 60s
	// browser/nginx-cacheable, same as the Python endpoint.
	// GET = 无口令访问（带口令的分享返回 401 password_required）；
	// POST = 提交口令换取试卷内容（口令错误 401）。
	g.GET("/shared/:share_token", func(c *gin.Context) {
		payload, err := svc.GetSharedQuiz(c.Request.Context(), c.Param("share_token"), "")
		if err != nil {
			respondAPIError(c, err)
			return
		}
		c.Header("Cache-Control", "public, max-age=60")
		c.Header("Vary", "Accept-Encoding")
		c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
	})
	g.POST("/shared/:share_token", func(c *gin.Context) {
		var body quizdto.SharePasswordRequest
		_ = c.ShouldBindJSON(&body)
		payload, err := svc.GetSharedQuiz(c.Request.Context(), c.Param("share_token"), body.Password)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
	})

	g.GET("/history", history(svc))
	g.GET("/wrong-answers", wrongAnswers(svc))
	g.GET("/export", export(svc))
	g.GET("/:quiz_uuid/paper", exportPaper(svc))

	g.POST("/:quiz_uuid/share", createShare(svc))
	g.GET("/:quiz_uuid/share", shareStatus(svc))
	g.DELETE("/:quiz_uuid/share", revokeShare(svc))
	g.PATCH("/:quiz_uuid", renameQuiz(svc))
	g.DELETE("/:quiz_uuid", deleteQuiz(svc))
	g.GET("/:quiz_uuid", getQuiz(svc))
}

// ── handlers ─────────────────────────────────────────────────────────

func history(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		page, ok := queryInt(c, "page", 1, 1, 0)
		if !ok {
			return
		}
		pageSize, ok := queryInt(c, "page_size", 10, 1, 100)
		if !ok {
			return
		}
		resp, err := svc.History(c.Request.Context(), uid, page, pageSize)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "查询失败，请稍后重试")
			return
		}
		renderTyped[quizdto.History](c, resp)
	}
}

func wrongAnswers(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		fids, ok := parseFolderIDs(c, c.Query("folder_ids"))
		if !ok {
			return
		}
		resp, err := svc.WrongAnswers(c.Request.Context(), uid, fids)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "查询失败，请稍后重试")
			return
		}
		renderTyped[quizdto.WrongAnswers](c, resp)
	}
}

func export(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		format, valid := service.ExportFormat(c.Query("format"))
		if !valid {
			apiErr(c, http.StatusBadRequest, "format 仅支持 jsonl / csv / sft")
			return
		}
		fids, ok := parseFolderIDs(c, c.Query("folder_ids"))
		if !ok {
			return
		}

		contentType := map[string]string{
			"jsonl": "application/jsonl",
			"csv":   "text/csv",
			"sft":   "application/jsonl",
		}[format]
		filename := "quiz_export_" + time.Now().Format("20060102_150405") + "." + format
		c.Header("Content-Disposition", "attachment; filename="+filename)
		c.Header("Cache-Control", "no-cache")
		c.Header("Content-Type", contentType)
		c.Status(http.StatusOK)

		w := c.Writer
		flusher, _ := w.(http.Flusher)
		err := svc.ExportSubmissions(c.Request.Context(), uid, fids, format, func(b []byte) error {
			if _, err := w.Write(b); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
			return nil
		})
		if err != nil && !errors.Is(err, io.EOF) {
			// Headers are already sent — log only; the client sees a
			// truncated stream (parity with the Python streaming failure).
			slog.Error("[QUIZ] export stream failed", "uid", uid, "err", err)
		}
	}
}

// exportPaper renders an owned quiz as an exam-style printable docx
// (query: style=standard|gaokao|kaoyan, with_answers=true|false).
func exportPaper(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		style := c.Query("style")
		if !exampaper.ValidStyle(style) {
			apiErr(c, http.StatusBadRequest, "style 仅支持 standard / gaokao / kaoyan")
			return
		}
		includeAnswers := c.Query("with_answers") == "true"
		data, title, err := svc.BuildPaper(c.Request.Context(), uid, c.Param("quiz_uuid"), service.PaperOptions{
			Style:          exampaper.NormalizeStyle(style),
			IncludeAnswers: includeAnswers,
		})
		if err != nil {
			respondAPIError(c, err)
			return
		}
		// RFC 5987 filename* for the Chinese filename; ASCII fallback alongside.
		name := "paper_" + time.Now().Format("20060102_150405") + ".docx"
		if cn := sanitizeFilename(title); cn != "" {
			name = "filename*=UTF-8''" + url.PathEscape("试卷_"+cn+".docx")
		}
		c.Header("Content-Disposition", "attachment; filename="+name)
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)
	}
}

// sanitizeFilename strips filesystem-unsafe characters and caps the length.
func sanitizeFilename(title string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t':
			return -1
		}
		return r
	}, strings.TrimSpace(title))
	runes := []rune(cleaned)
	if len(runes) > 80 {
		runes = runes[:80]
	}
	return string(runes)
}

type createShareBody = quizdto.CreateShareRequest

func createShare(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := c.Param("quiz_uuid")

		// Body is optional: absent / null → never expires (parity with the
		// Python Body(default_factory=dict) handling).
		var body createShareBody
		raw, err := c.GetRawData()
		if err == nil && len(strings.TrimSpace(string(raw))) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				apiErr(c, http.StatusBadRequest, "请求体必须是 JSON 对象")
				return
			}
		}
		var days *int
		if body.ExpiresInDays != nil {
			n, err := strconv.Atoi(body.ExpiresInDays.String())
			if err != nil {
				apiErr(c, http.StatusBadRequest, "expires_in_days 必须是整数或 null")
				return
			}
			days = &n
		}

		resp, err := svc.CreateShare(c.Request.Context(), quizUUID, uid, days, body.Password)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.ShareState](c, resp)
	}
}

func shareStatus(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		resp, err := svc.ShareStatus(c.Request.Context(), c.Param("quiz_uuid"), uid)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.ShareState](c, resp)
	}
}

func revokeShare(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		resp, err := svc.RevokeShare(c.Request.Context(), c.Param("quiz_uuid"), uid)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.ShareState](c, resp)
	}
}

func renameQuiz(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var body quizdto.RenameRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体需为 JSON：{title}")
			return
		}
		resp, err := svc.RenameQuiz(c.Request.Context(), uid, c.Param("quiz_uuid"), body.Title)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.RenameResult](c, resp)
	}
}

func deleteQuiz(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		resp, err := svc.DeleteQuiz(c.Request.Context(), uid, c.Param("quiz_uuid"))
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.DeleteResult](c, resp)
	}
}

func getQuiz(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		includeAnswers := c.Query("include_answers") == "true"
		resp, err := svc.GetQuiz(c.Request.Context(), uid, c.Param("quiz_uuid"), includeAnswers)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		renderTyped[quizdto.QuizDetail](c, resp)
	}
}

// ── helpers ──────────────────────────────────────────────────────────

// respondAPIError renders the shared apperr model (service errors are
// *apperr.Error aliases).
func respondAPIError(c *gin.Context, err error) {
	middleware.RespondError(c, err)
}

// parseFolderIDs validates the comma-separated folder_ids query parameter
// (parity with the Python router helper).
func parseFolderIDs(c *gin.Context, raw string) ([]int, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, true
	}
	parts := strings.Split(raw, ",")
	fids := make([]int, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			apiErr(c, http.StatusBadRequest, "folder_ids 格式非法")
			return nil, false
		}
		fids = append(fids, n)
	}
	return fids, true
}

// queryInt parses a query param with default and inclusive bounds; FastAPI's
// 422s collapse into 400s with an equivalent message (the frontend does not
// parse the validation-error shape).
func queryInt(c *gin.Context, name string, def, min, max int) (int, bool) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		apiErr(c, http.StatusBadRequest, name+" 必须是整数")
		return 0, false
	}
	if n < min || (max > 0 && n > max) {
		apiErr(c, http.StatusBadRequest, name+" 超出允许范围")
		return 0, false
	}
	return n, true
}
