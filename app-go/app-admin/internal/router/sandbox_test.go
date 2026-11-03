// Sandbox console proxy tests: the viewer/admin split,
// the {"detail"} mapping for unconfigured / upstream 4xx / upstream failure,
// verbatim query + body pass-through, and the app-admin audit trail for the two
// writes. Everything is httptest + in-memory: no MySQL and no real app-sandbox
// (the router tests inject identity like the session gate would, because the
// real gate is DB-backed and covered by TestAPI401WithoutCookie).
package router

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"app-admin/internal/config"
	"app-admin/internal/sandbox"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

// ── helpers ──────────────────────────────────────────────────────────

// sandboxTestEngine mounts ONLY the sandbox routes with a fake session gate that
// trusts the X-Test-Role header ("" = unauthenticated).
func sandboxTestEngine(svc *service.SandboxService) *gin.Engine {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	r := &Router{cfg: &config.Config{}, sandbox: svc}
	gate := e.Group("/api", func(c *gin.Context) {
		role := c.GetHeader("X-Test-Role")
		if role == "" {
			detail(c, http.StatusUnauthorized, "login required")
			c.Abort()
			return
		}
		c.Set(ctxIdentity, adminIdentity{Username: "ops-admin", Role: role})
		c.Next()
	})
	r.registerSandboxRoutes(gate)
	return e
}

// doRequest performs one console request; role "" leaves the request anonymous.
func doRequest(e *gin.Engine, method, path, role, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if role != "" {
		req.Header.Set("X-Test-Role", role)
	}
	e.ServeHTTP(rec, req)
	return rec
}

// upstreamCall is one request the fake app-sandbox received.
type upstreamCall struct {
	Method    string
	Path      string
	RawQuery  string
	Token     string
	RequestID string
}

// sandboxUpstream is a fake app-sandbox admin API: it records every call and
// answers with one canned status/body.
type sandboxUpstream struct {
	mu     sync.Mutex
	calls  []upstreamCall
	status int
	body   string
	server *httptest.Server
}

func newSandboxUpstream(t *testing.T, status int, body string) *sandboxUpstream {
	t.Helper()
	u := &sandboxUpstream{status: status, body: body}
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.calls = append(u.calls, upstreamCall{
			Method:    r.Method,
			Path:      r.URL.Path,
			RawQuery:  r.URL.RawQuery,
			Token:     r.Header.Get("X-Admin-Token"),
			RequestID: r.Header.Get("X-Request-Id"),
		})
		status, body := u.status, u.body
		u.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(u.server.Close)
	return u
}

func (u *sandboxUpstream) recorded() []upstreamCall {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]upstreamCall(nil), u.calls...)
}

// auditRow is one ledger write captured by the fake recorder.
type auditRow struct {
	Admin, Action, TargetType, TargetID, Detail string
}

func newAuditRecorder() (*[]auditRow, service.AuditRecorder) {
	var mu sync.Mutex
	rows := []auditRow{}
	recorder := func(admin, action, targetType, targetID, detail string) error {
		mu.Lock()
		defer mu.Unlock()
		rows = append(rows, auditRow{admin, action, targetType, targetID, detail})
		return nil
	}
	return &rows, recorder
}

func wiredSandbox(t *testing.T, up *sandboxUpstream) (*service.SandboxService, *[]auditRow) {
	t.Helper()
	rows, audit := newAuditRecorder()
	return service.NewSandboxServiceWithAudit(sandbox.NewClient(up.server.URL, "s3cret-token"), audit), rows
}

// ── auth gate ────────────────────────────────────────────────────────

// Every sandbox route is behind the session gate: no cookie = 401 {"detail"}
// before any handler (and therefore before any upstream call).
func TestSandboxRoutesRequireLogin(t *testing.T) {
	e := newTestRouter() // real session gate, no DB round-trip without a cookie
	routes := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/sandbox/overview"},
		{http.MethodGet, "/api/sandbox/executions"},
		{http.MethodGet, "/api/sandbox/executions/e1"},
		{http.MethodGet, "/api/sandbox/leases"},
		{http.MethodGet, "/api/sandbox/quota"},
		{http.MethodGet, "/api/sandbox/audit"},
		{http.MethodGet, "/api/sandbox/config"},
		{http.MethodPost, "/api/sandbox/executions/e1/cancel"},
		{http.MethodPost, "/api/sandbox/leases/l1/release"},
	}
	for _, route := range routes {
		// The browser CSRF origin gate runs BEFORE the session gate, so a real
		// SPA always sends Origin; the test must too (POST without it is 403
		// "origin required" and never reaches the session check).
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(route.method, route.path, nil)
		req.Header.Set("Origin", "http://"+req.Host)
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without session must be 401, got %d body=%s", route.method, route.path, rec.Code, rec.Body.String())
		}
		if rec.Body.String() != `{"detail":"login required"}` {
			t.Fatalf("%s %s body must be detail-shaped, got %s", route.method, route.path, rec.Body.String())
		}
	}
}

// viewer reads fine; viewer writes are the admin red line (403, no upstream
// call, no audit row).
func TestSandboxViewerCanReadButNotWrite(t *testing.T) {
	up := newSandboxUpstream(t, http.StatusOK, `{"leases":{"total":0}}`)
	svc, rows := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)

	if rec := doRequest(e, http.MethodGet, "/api/sandbox/overview", "viewer", ""); rec.Code != http.StatusOK {
		t.Fatalf("viewer must read the overview, got %d body=%s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/sandbox/executions/e1/cancel", "/api/sandbox/leases/l1/release"} {
		rec := doRequest(e, http.MethodPost, path, "viewer", `{"reason":"audit only"}`)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("viewer %s must be 403, got %d body=%s", path, rec.Code, rec.Body.String())
		}
		if rec.Body.String() != `{"detail":"admin role required"}` {
			t.Fatalf("viewer %s body must be detail-shaped, got %s", path, rec.Body.String())
		}
	}
	if calls := up.recorded(); len(calls) != 1 {
		t.Fatalf("only the viewer read may reach upstream, got %d calls: %+v", len(calls), calls)
	}
	if len(*rows) != 0 {
		t.Fatalf("a rejected role must not write an audit row: %+v", *rows)
	}
}

// ── writes: proxy + audit ────────────────────────────────────────────

func TestSandboxAdminWritesProxyAndAudit(t *testing.T) {
	up := newSandboxUpstream(t, http.StatusOK, `{"ok":true}`)
	svc, rows := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)

	rec := doRequest(e, http.MethodPost, "/api/sandbox/executions/e-42/cancel", "admin", `{"reason":"agent stuck"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin cancel must pass, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("upstream body must be passed through, got %s", rec.Body.String())
	}

	rec = doRequest(e, http.MethodPost, "/api/sandbox/leases/l-7/release", "admin", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin release must pass, got %d body=%s", rec.Code, rec.Body.String())
	}

	calls := up.recorded()
	if len(calls) != 2 {
		t.Fatalf("expected 2 upstream calls, got %d: %+v", len(calls), calls)
	}
	if calls[0].Method != http.MethodPost || calls[0].Path != "/internal/admin/executions/e-42/cancel" {
		t.Fatalf("cancel must proxy to POST /internal/admin/executions/:id/cancel, got %s %s", calls[0].Method, calls[0].Path)
	}
	if calls[1].Method != http.MethodDelete || calls[1].Path != "/internal/admin/leases/l-7" {
		t.Fatalf("release must proxy to DELETE /internal/admin/leases/:id, got %s %s", calls[1].Method, calls[1].Path)
	}
	for _, call := range calls {
		if call.Token != "s3cret-token" {
			t.Fatalf("X-Admin-Token must carry the configured secret, got %q", call.Token)
		}
		if call.RequestID == "" {
			t.Fatal("every upstream call must carry an X-Request-Id correlation id")
		}
	}

	if len(*rows) != 2 {
		t.Fatalf("both writes must be audited, got %+v", *rows)
	}
	cancel := (*rows)[0]
	if cancel.Admin != "ops-admin" || cancel.Action != "sandbox.execution.cancel" ||
		cancel.TargetType != "sandbox_execution" || cancel.TargetID != "e-42" {
		t.Fatalf("unexpected cancel audit row: %+v", cancel)
	}
	if !strings.Contains(cancel.Detail, "reason=agent stuck") {
		t.Fatalf("cancel audit detail must carry the operator reason, got %q", cancel.Detail)
	}
	release := (*rows)[1]
	if release.Action != "sandbox.lease.release" || release.TargetType != "sandbox_lease" || release.TargetID != "l-7" {
		t.Fatalf("unexpected release audit row: %+v", release)
	}
	if !strings.Contains(release.Detail, "reason=(no reason given)") {
		t.Fatalf("missing reason must be explicit in the ledger, got %q", release.Detail)
	}
}

// An empty upstream 2xx body (idempotent cancel / DELETE 204) still answers the
// console success shape.
func TestSandboxAdminWriteEmptyUpstreamBody(t *testing.T) {
	up := newSandboxUpstream(t, http.StatusNoContent, "")
	svc, rows := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)

	rec := doRequest(e, http.MethodPost, "/api/sandbox/executions/e1/cancel", "admin", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"ok":true}` {
		t.Fatalf("empty upstream body must map to {ok:true}, got %d %s", rec.Code, rec.Body.String())
	}
	if len(*rows) != 1 {
		t.Fatalf("the write must still be audited, got %+v", *rows)
	}
}

// A ledger failure must fail the write: an unaudited admin action is not
// acceptable (the operator sees 500 and the sandbox state is re-read).
func TestSandboxAuditFailureFailsWrite(t *testing.T) {
	up := newSandboxUpstream(t, http.StatusOK, `{"ok":true}`)
	svc := service.NewSandboxServiceWithAudit(
		sandbox.NewClient(up.server.URL, "s3cret-token"),
		func(string, string, string, string, string) error { return errors.New("audit table down") },
	)
	e := sandboxTestEngine(svc)

	rec := doRequest(e, http.MethodPost, "/api/sandbox/executions/e1/cancel", "admin", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure must surface as 500, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"detail":"internal error"}` {
		t.Fatalf("internal failures must stay opaque, got %s", rec.Body.String())
	}
}

// ── unconfigured / upstream failures ─────────────────────────────────

func TestSandboxUnconfiguredReturns503(t *testing.T) {
	cases := []struct {
		name string
		svc  *service.SandboxService
	}{
		{"both empty", service.NewSandboxServiceWithAudit(sandbox.NewClient("", ""), nil)},
		{"lone base url", service.NewSandboxServiceWithAudit(sandbox.NewClient("http://app-sandbox:8017", ""), nil)},
		{"nil client", service.NewSandboxService(nil)},
	}
	for _, tc := range cases {
		e := sandboxTestEngine(tc.svc)
		for _, path := range []string{"/api/sandbox/overview", "/api/sandbox/leases", "/api/sandbox/config"} {
			if rec := doRequest(e, http.MethodGet, path, "viewer", ""); rec.Code != http.StatusServiceUnavailable ||
				rec.Body.String() != `{"detail":"sandbox 管理未配置"}` {
				t.Fatalf("%s %s must be 503 configured-hint, got %d %s", tc.name, path, rec.Code, rec.Body.String())
			}
		}
		rec := doRequest(e, http.MethodPost, "/api/sandbox/leases/l1/release", "admin", "")
		if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"detail":"sandbox 管理未配置"}` {
			t.Fatalf("%s write must be 503 too, got %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
}

// Upstream 4xx is echoed verbatim (status + detail) so the console shows the
// control plane's precise reason; no audit row is written for a failed write.
func TestSandboxUpstream4xxPassthrough(t *testing.T) {
	cases := []struct {
		status int
		body   string
	}{
		{http.StatusNotFound, `{"detail":"执行记录不存在"}`},
		{http.StatusBadRequest, `{"detail":"status 取值无效"}`},
		{http.StatusConflict, `{"detail":"租约正在回收"}`},
	}
	for _, tc := range cases {
		up := newSandboxUpstream(t, tc.status, tc.body)
		svc, rows := wiredSandbox(t, up)
		e := sandboxTestEngine(svc)

		rec := doRequest(e, http.MethodGet, "/api/sandbox/executions/e1", "viewer", "")
		if rec.Code != tc.status {
			t.Fatalf("upstream %d must be echoed, got %d body=%s", tc.status, rec.Code, rec.Body.String())
		}
		if rec.Body.String() != tc.body {
			t.Fatalf("upstream detail must be passed through verbatim: want %s got %s", tc.body, rec.Body.String())
		}
		if len(*rows) != 0 {
			t.Fatalf("a failed upstream call must not be audited: %+v", *rows)
		}
	}
}

// 5xx, transport failures and malformed payloads collapse into 502
// {"detail":"sandbox 服务不可用"} (the cause goes to the server logs).
func TestSandboxUpstreamFailureReturns502(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusServiceUnavailable, http.StatusGatewayTimeout} {
		up := newSandboxUpstream(t, status, `{"detail":"db down"}`)
		svc, _ := wiredSandbox(t, up)
		e := sandboxTestEngine(svc)

		rec := doRequest(e, http.MethodGet, "/api/sandbox/overview", "viewer", "")
		if rec.Code != http.StatusBadGateway || rec.Body.String() != `{"detail":"sandbox 服务不可用"}` {
			t.Fatalf("upstream %d must map to 502, got %d %s", status, rec.Code, rec.Body.String())
		}
	}

	// Malformed 2xx payload: a proxy/HTML page must not be handed to the SPA.
	up := newSandboxUpstream(t, http.StatusOK, "<html>gateway</html>")
	svc, _ := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)
	if rec := doRequest(e, http.MethodGet, "/api/sandbox/overview", "viewer", ""); rec.Code != http.StatusBadGateway {
		t.Fatalf("malformed upstream JSON must map to 502, got %d %s", rec.Code, rec.Body.String())
	}

	// Unreachable upstream (connection refused).
	dead := newSandboxUpstream(t, http.StatusOK, "{}")
	deadAddr := dead.server.URL
	dead.server.Close()
	deadSvc := service.NewSandboxServiceWithAudit(sandbox.NewClient(deadAddr, "t"), nil)
	deadEngine := sandboxTestEngine(deadSvc)
	if rec := doRequest(deadEngine, http.MethodGet, "/api/sandbox/overview", "viewer", ""); rec.Code != http.StatusBadGateway {
		t.Fatalf("unreachable upstream must map to 502, got %d %s", rec.Code, rec.Body.String())
	}
}

// Upstream 401/403 means app-admin's own token is wrong. It must NOT surface as
// 401 — the admin SPA would treat that as an expired session and log the
// operator out mid-task.
func TestSandboxUpstreamAuthFailureDoesNotSurface401(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		up := newSandboxUpstream(t, status, `{"detail":"无效的 Admin Token"}`)
		svc, _ := wiredSandbox(t, up)
		e := sandboxTestEngine(svc)

		rec := doRequest(e, http.MethodGet, "/api/sandbox/overview", "viewer", "")
		if rec.Code == http.StatusUnauthorized {
			t.Fatalf("upstream %d must not reach the SPA as 401", status)
		}
		if rec.Code != http.StatusBadGateway || rec.Body.String() != `{"detail":"sandbox 服务不可用"}` {
			t.Fatalf("upstream %d must map to an opaque 502, got %d %s", status, rec.Code, rec.Body.String())
		}
	}
}

// ── reads: pass-through ──────────────────────────────────────────────

// Read responses are proxied byte for byte and the whitelisted filters reach the
// control plane unchanged (absent params stay absent → upstream defaults).
func TestSandboxReadsPassThroughBodyAndQuery(t *testing.T) {
	payload := `{"items":[{"id":"e1","status":"failed"}],"total":1,"page":2,"pageSize":50}`
	up := newSandboxUpstream(t, http.StatusOK, payload)
	svc, _ := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)

	query := url.Values{
		"uid":       {"42"},
		"projectId": {"proj-1"},
		"status":    {"failed"},
		"from":      {"2026-01-01T00:00:00Z"},
		"to":        {"2026-02-01T00:00:00Z"},
		"page":      {"2"},
		"pageSize":  {"50"},
	}
	rec := doRequest(e, http.MethodGet, "/api/sandbox/executions?"+query.Encode(), "viewer", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer list must pass, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != payload {
		t.Fatalf("upstream body must be proxied verbatim: want %s got %s", payload, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content type must stay JSON, got %q", ct)
	}

	calls := up.recorded()
	if len(calls) != 1 || calls[0].Path != "/internal/admin/executions" {
		t.Fatalf("unexpected upstream calls: %+v", calls)
	}
	got, err := url.ParseQuery(calls[0].RawQuery)
	if err != nil {
		t.Fatalf("upstream query unparsable: %v", err)
	}
	for key, want := range query {
		if got.Get(key) != want[0] {
			t.Fatalf("filter %s must be forwarded: want %q got %q", key, want[0], got.Get(key))
		}
	}

	// quota forwards uid + day and nothing else
	quota := url.Values{"uid": {"42"}, "day": {"2026-11-01"}}
	if rec := doRequest(e, http.MethodGet, "/api/sandbox/quota?"+quota.Encode(), "viewer", ""); rec.Code != http.StatusOK {
		t.Fatalf("quota read must pass, got %d body=%s", rec.Code, rec.Body.String())
	}
	calls = up.recorded()
	if len(calls) != 2 || calls[1].Path != "/internal/admin/quota" || calls[1].RawQuery != quota.Encode() {
		t.Fatalf("quota query must be forwarded verbatim: %+v", calls[1])
	}
}

// Only the params app-admin must parse itself are rejected locally; everything
// else is the control plane's call.
func TestSandboxQueryValidation(t *testing.T) {
	up := newSandboxUpstream(t, http.StatusOK, `{}`)
	svc, _ := wiredSandbox(t, up)
	e := sandboxTestEngine(svc)

	cases := []string{
		"/api/sandbox/executions?uid=abc",
		"/api/sandbox/executions?uid=0",
		"/api/sandbox/leases?page=0",
		"/api/sandbox/audit?pageSize=101",
	}
	for _, path := range cases {
		rec := doRequest(e, http.MethodGet, path, "viewer", "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s must be rejected with 400, got %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	if len(up.recorded()) != 0 {
		t.Fatal("locally rejected requests must never reach upstream")
	}

	// Opaque ids are bounded but not interpreted.
	rec := doRequest(e, http.MethodGet, "/api/sandbox/executions/"+strings.Repeat("x", 65), "viewer", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("over-long id must be rejected with 400, got %d", rec.Code)
	}
}
