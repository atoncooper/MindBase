// Sandbox console proxy: /api/sandbox/* forwards to
// app-sandbox's /internal/admin/* surface.
//
// Role split: every read is viewer+ (auditors get the full picture), while the
// two mutations — cancel an execution, force-release a lease — sit behind
// requireAdmin, the same red line as the share moderation writes.
//
// app-admin adds no sandbox semantics of its own. Only the params the proxy must
// parse itself are validated here (uid, the shared page window, the opaque id);
// every other filter is forwarded untouched so the control plane's 400 {detail}
// stays the single authority. Responses are passed through byte for byte (no
// re-marshalling), so upstream field additions need no app-admin change.
package router

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"app-admin/internal/sandbox"

	"github.com/gin-gonic/gin"
)

// registerSandboxRoutes mounts the read and write halves separately: the write
// group carries requireAdmin, so a viewer never even reaches an upstream
// mutation (and no audit row is written for a rejected role).
func (r *Router) registerSandboxRoutes(api *gin.RouterGroup) {
	read := api.Group("/sandbox")
	read.GET("/overview", r.apiSandboxOverview)
	read.GET("/executions", r.apiSandboxExecutions)
	read.GET("/executions/:id", r.apiSandboxExecution)
	read.GET("/leases", r.apiSandboxLeases)
	read.GET("/quota", r.apiSandboxQuota)
	read.GET("/audit", r.apiSandboxAudit)
	read.GET("/config", r.apiSandboxConfig)

	write := api.Group("/sandbox", requireAdmin())
	write.POST("/executions/:id/cancel", r.apiSandboxCancelExecution)
	write.POST("/leases/:id/release", r.apiSandboxReleaseLease)
}

func (r *Router) apiSandboxOverview(c *gin.Context) {
	body, err := r.sandbox.Overview(c.Request.Context())
	respondSandbox(c, body, err, "sandbox overview")
}

func (r *Router) apiSandboxExecutions(c *gin.Context) {
	if !r.validSandboxFilters(c) {
		return // 400 already written
	}
	body, err := r.sandbox.Executions(c.Request.Context(),
		sandboxQuery(c, "uid", "projectId", "status", "from", "to", "page", "pageSize"))
	respondSandbox(c, body, err, "sandbox executions")
}

func (r *Router) apiSandboxExecution(c *gin.Context) {
	id, ok := sandboxID(c)
	if !ok {
		return // 400 already written
	}
	body, err := r.sandbox.Execution(c.Request.Context(), id)
	respondSandbox(c, body, err, "sandbox execution detail")
}

// apiSandboxCancelExecution — POST /api/sandbox/executions/:id/cancel (admin).
// Cancel is idempotent upstream, so repeated confirmations are harmless; each
// confirmed call still writes its own ledger row with the operator and reason.
func (r *Router) apiSandboxCancelExecution(c *gin.Context) {
	id, ok := sandboxID(c)
	if !ok {
		return
	}
	var req sandboxActionRequest
	_ = c.ShouldBindJSON(&req) // optional reason; missing/invalid body tolerated like the moderation writes
	admin, _ := identityOf(c)
	body, err := r.sandbox.CancelExecution(c.Request.Context(), admin.Username, id, req.Reason)
	respondSandbox(c, body, err, "sandbox execution cancel")
}

// apiSandboxReleaseLease — POST /api/sandbox/leases/:id/release (admin).
// Force-release cancels the in-flight execution and deletes the runtime sandbox
// upstream; the proxy only records who asked and why.
func (r *Router) apiSandboxReleaseLease(c *gin.Context) {
	id, ok := sandboxID(c)
	if !ok {
		return
	}
	var req sandboxActionRequest
	_ = c.ShouldBindJSON(&req)
	admin, _ := identityOf(c)
	body, err := r.sandbox.ReleaseLease(c.Request.Context(), admin.Username, id, req.Reason)
	respondSandbox(c, body, err, "sandbox lease release")
}

func (r *Router) apiSandboxLeases(c *gin.Context) {
	if !r.validSandboxFilters(c) {
		return
	}
	body, err := r.sandbox.Leases(c.Request.Context(),
		sandboxQuery(c, "uid", "state", "page", "pageSize"))
	respondSandbox(c, body, err, "sandbox leases")
}

func (r *Router) apiSandboxQuota(c *gin.Context) {
	if !r.validSandboxFilters(c) {
		return
	}
	body, err := r.sandbox.Quota(c.Request.Context(), sandboxQuery(c, "uid", "day"))
	respondSandbox(c, body, err, "sandbox quota")
}

func (r *Router) apiSandboxAudit(c *gin.Context) {
	if !r.validSandboxFilters(c) {
		return
	}
	body, err := r.sandbox.AuditLog(c.Request.Context(),
		sandboxQuery(c, "uid", "action", "from", "to", "page", "pageSize"))
	respondSandbox(c, body, err, "sandbox audit")
}

func (r *Router) apiSandboxConfig(c *gin.Context) {
	body, err := r.sandbox.RuntimeConfig(c.Request.Context())
	respondSandbox(c, body, err, "sandbox runtime config")
}

// sandboxActionRequest is the optional confirm-dialog body of a sandbox write;
// the reason only feeds the app-admin ledger (the upstream API takes none).
type sandboxActionRequest struct {
	Reason string `json:"reason"`
}

// sandboxID reads the opaque upstream id from the :id path segment. Ids are
// UUIDs, so a generous bounded check is enough — the control plane answers 404
// for anything unknown, which the proxy passes through.
func sandboxID(c *gin.Context) (string, bool) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" || len(id) > 64 {
		detail(c, http.StatusBadRequest, "id must be a non-empty identifier (max 64 chars)")
		return "", false
	}
	return id, true
}

// validSandboxFilters rejects only the params the proxy must parse itself:
// uid (positive integer) and the shared page/pageSize window. Enum, date and
// timestamp filters are forwarded untouched on purpose — duplicating their
// validation here would drift from the control plane's contract.
func (r *Router) validSandboxFilters(c *gin.Context) bool {
	if v := c.Query("uid"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err != nil || n <= 0 {
			detail(c, http.StatusBadRequest, "uid must be a positive integer")
			return false
		}
	}
	if _, _, ok := r.parsePage(c); !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return false
	}
	return true
}

// sandboxQuery copies the whitelisted query params verbatim; absent params stay
// absent so the upstream defaults (page 1, pageSize 20) keep applying.
func sandboxQuery(c *gin.Context, keys ...string) url.Values {
	q := url.Values{}
	for _, key := range keys {
		if v := c.Query(key); v != "" {
			q.Set(key, v)
		}
	}
	return q
}

// respondSandbox writes a proxied body. Upstream 2xx JSON goes through byte for
// byte (no re-marshalling, so new upstream fields appear immediately); an empty
// 2xx body becomes {"ok":true}, the success shape the console expects from the
// two write endpoints.
func respondSandbox(c *gin.Context, body json.RawMessage, err error, what string) {
	if err != nil {
		sandboxError(c, err, what)
		return
	}
	if len(body) == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

// sandboxError maps the client's typed errors onto the console contract:
//   - not configured      -> 503 "sandbox 管理未配置" (other console pages intact)
//   - upstream 4xx        -> that status + its {detail} verbatim
//   - upstream 5xx / down -> 502 "sandbox 服务不可用" (cause goes to the logs)
//   - anything else       -> opaque 500 via serverError
func sandboxError(c *gin.Context, err error, what string) {
	var upstream *sandbox.UpstreamError
	switch {
	case errors.Is(err, sandbox.ErrNotConfigured):
		detail(c, http.StatusServiceUnavailable, "sandbox 管理未配置")
	case errors.As(err, &upstream):
		detail(c, upstream.Status, upstream.Detail)
	case errors.Is(err, sandbox.ErrUnavailable):
		slog.Warn("[SANDBOX_ADMIN] upstream unavailable", "what", what, "err", err)
		detail(c, http.StatusBadGateway, "sandbox 服务不可用")
	default:
		serverError(c, err, what)
	}
}
