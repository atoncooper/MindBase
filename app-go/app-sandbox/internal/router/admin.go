// Internal admin API: /internal/admin/* serves the app-admin
// console. It is authenticated by the separate X-Admin-Token shared secret — NOT
// the APISIX consumer key — because app-admin is the only caller and the token
// never reaches a browser. A missing configured token disables the whole group
// with 503 so a half-configured deployment cannot expose operations data.
package router

import (
	"crypto/subtle"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/repo"

	"github.com/gin-gonic/gin"
)

// registerAdmin wires the admin group. It is registered on a fresh group so the
// X-Admin-Token middleware never applies to /v1 or the legacy /internal routes.
func registerAdmin(e *gin.Engine, d Deps) {
	g := e.Group("/internal/admin", adminTokenAuth(d.Cfg))
	g.GET("/overview", func(c *gin.Context) { adminOverview(c, d) })
	g.GET("/executions", func(c *gin.Context) { adminExecutions(c, d) })
	g.GET("/executions/:id", func(c *gin.Context) { adminExecutionDetail(c, d) })
	g.POST("/executions/:id/cancel", func(c *gin.Context) { adminCancelExecution(c, d) })
	g.GET("/leases", func(c *gin.Context) { adminLeases(c, d) })
	g.DELETE("/leases/:id", func(c *gin.Context) { adminReleaseLease(c, d) })
	g.GET("/quota", func(c *gin.Context) { adminQuota(c, d) })
	g.GET("/audit", func(c *gin.Context) { adminAudit(c, d) })
	g.GET("/config", func(c *gin.Context) { adminConfig(c, d) })
}

// adminTokenAuth enforces the shared admin token (constant-time compare).
// Unconfigured token -> 503 {"detail":"admin api disabled"}; wrong/missing
// token -> 401 {"detail":...}.
func adminTokenAuth(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		expected := strings.TrimSpace(cfg.Admin.Token)
		if expected == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"detail": "admin api disabled"})
			c.Abort()
			return
		}
		provided := strings.TrimSpace(c.GetHeader("X-Admin-Token"))
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			apiErr(c, http.StatusUnauthorized, "未授权")
			c.Abort()
			return
		}
		c.Next()
	}
}

// ── handlers ─────────────────────────────────────────────────────────

func adminOverview(c *gin.Context, d Deps) {
	view, err := d.Admin.Overview(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminExecutions(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	from, ok := parseTimeQuery(c, "from")
	if !ok {
		return
	}
	to, ok := parseTimeQuery(c, "to")
	if !ok {
		return
	}
	page, pageSize := parsePaging(c)
	view, err := d.Admin.Executions(c.Request.Context(), repo.ExecutionFilter{
		UID:       uid,
		ProjectID: strings.TrimSpace(c.Query("projectId")),
		Statuses:  parseCSV(c.Query("status")),
		From:      from,
		To:        to,
		Page:      page,
		PageSize:  pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminExecutionDetail(c *gin.Context, d Deps) {
	view, err := d.Admin.ExecutionDetail(c.Request.Context(), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminCancelExecution(c *gin.Context, d Deps) {
	if err := d.Admin.CancelExecution(c.Request.Context(), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func adminLeases(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	page, pageSize := parsePaging(c)
	view, err := d.Admin.Leases(c.Request.Context(), repo.LeaseFilter{
		UID:      uid,
		States:   parseCSV(c.Query("state")),
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminReleaseLease(c *gin.Context, d Deps) {
	if err := d.Admin.ReleaseLease(c.Request.Context(), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func adminQuota(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	if uid == nil {
		apiErr(c, http.StatusBadRequest, "uid 必填")
		return
	}
	view, err := d.Admin.Quota(c.Request.Context(), *uid, strings.TrimSpace(c.Query("day")))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminAudit(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	from, ok := parseTimeQuery(c, "from")
	if !ok {
		return
	}
	to, ok := parseTimeQuery(c, "to")
	if !ok {
		return
	}
	page, pageSize := parsePaging(c)
	view, err := d.Admin.Audit(c.Request.Context(), repo.AuditFilter{
		UID:      uid,
		Action:   strings.TrimSpace(c.Query("action")),
		From:     from,
		To:       to,
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func adminConfig(c *gin.Context, d Deps) {
	c.JSON(http.StatusOK, d.Admin.RuntimeConfig())
}

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
