// Quiz endpoints — port of the storage-face slice of app/routers/quiz.py:
// history, wrong-answer notebook, export, detail, delete and sharing.
// generate / generate-from-summary / submit stay in the Python backend
// (AI-bearing flows).
package router

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-quiz/internal/service"

	"github.com/gin-gonic/gin"
)

func registerQuiz(e *gin.Engine, svc *service.Store) {
	g := e.Group("/quiz")

	// Public sharing — declared before /:quiz_uuid so the static segment
	// wins (Gin prioritises static over param at the same level). 60s
	// browser/nginx-cacheable, same as the Python endpoint.
	g.GET("/shared/:share_token", func(c *gin.Context) {
		payload, err := svc.GetSharedQuiz(c.Request.Context(), c.Param("share_token"))
		if err != nil {
			respondAPIError(c, err)
			return
		}
		c.Header("Cache-Control", "public, max-age=60")
		c.Header("Vary", "Accept-Encoding")
		c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
	})

	g.GET("/history", history(svc))
	g.GET("/wrong-answers", wrongAnswers(svc))
	g.GET("/export", export(svc))

	g.POST("/:quiz_uuid/share", createShare(svc))
	g.GET("/:quiz_uuid/share", shareStatus(svc))
	g.DELETE("/:quiz_uuid/share", revokeShare(svc))
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
		c.JSON(http.StatusOK, resp)
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
		resp, err := svc.WrongAnswers(uid, fids)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "查询失败，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, resp)
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
		err := svc.ExportSubmissions(svc.DB, uid, fids, format, func(b []byte) error {
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

type createShareBody struct {
	ExpiresInDays *json.Number `json:"expires_in_days"`
}

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
		var expiresAt *time.Time
		if body.ExpiresInDays != nil {
			days, err := strconv.Atoi(body.ExpiresInDays.String())
			if err != nil {
				apiErr(c, http.StatusBadRequest, "expires_in_days 必须是整数或 null")
				return
			}
			if days < 1 || days > 365 {
				apiErr(c, http.StatusBadRequest, "有效期必须在 1~365 天之间")
				return
			}
			t := time.Now().UTC().AddDate(0, 0, days)
			expiresAt = &t
		}

		resp, err := svc.CreateShare(c.Request.Context(), quizUUID, uid, expiresAt)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

func shareStatus(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		resp, err := svc.ShareStatus(c.Param("quiz_uuid"), uid)
		if err != nil {
			respondAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
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
		c.JSON(http.StatusOK, resp)
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
		c.JSON(http.StatusOK, resp)
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
		c.JSON(http.StatusOK, resp)
	}
}

// ── helpers ──────────────────────────────────────────────────────────

// respondAPIError maps service.APIError to its HTTP status, everything else
// to 500.
func respondAPIError(c *gin.Context, err error) {
	var statusErr *service.APIError
	if errors.As(err, &statusErr) {
		apiErr(c, statusErr.Status, statusErr.Detail)
		return
	}
	apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
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
