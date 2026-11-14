package router

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ── query parsing (bad input -> 400, never silently wrong data) ───────

func parseUIDQuery(c *gin.Context) (*int64, bool) {
	raw := strings.TrimSpace(c.Query("uid"))
	if raw == "" {
		return nil, true
	}
	uid, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || uid <= 0 {
		apiErr(c, http.StatusBadRequest, "uid 无效")
		return nil, false
	}
	return &uid, true
}

// parsePaging returns the raw page/pageSize; repo.NormalizePagination clamps them
// (page >= 1, pageSize 1..100, default 20) and the response echoes the result.
func parsePaging(c *gin.Context) (int, int) {
	page, _ := strconv.Atoi(strings.TrimSpace(c.Query("page")))
	pageSize, _ := strconv.Atoi(strings.TrimSpace(c.Query("pageSize")))
	return page, pageSize
}

// parseTimeQuery accepts RFC3339, a plain date (YYYY-MM-DD, UTC) or unix seconds.
func parseTimeQuery(c *gin.Context, name string) (*time.Time, bool) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return nil, true
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return &parsed, true
	}
	if parsed, err := time.Parse("2006-01-02", raw); err == nil {
		return &parsed, true
	}
	if unix, err := strconv.ParseInt(raw, 10, 64); err == nil {
		parsed := time.Unix(unix, 0).UTC()
		return &parsed, true
	}
	apiErr(c, http.StatusBadRequest, name+" 时间格式无效")
	return nil, false
}

func parseCSV(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}
