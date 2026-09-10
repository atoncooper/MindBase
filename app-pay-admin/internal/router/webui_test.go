package router

// Tests for the pay admin console auth hardening: username+password login,
// session cookie flow, per-IP brute-force throttling, role gating, and the
// CORS / security response headers (mirrors app-task's webui tests).

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"app-pay-admin/internal/config"
	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"
	"app-pay-admin/internal/service"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupTestDB swaps the global GORM handle for a fresh in-memory SQLite with
// every model migrated (including the pay_* row mappings — production MySQL
// never migrates them, but the test tables mirror the real schema).
func setupTestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(
		&model.PayOrder{}, &model.PayMembership{}, &model.PayMembershipEvent{},
		&model.PayCallbackLog{}, &model.PayProduct{}, &model.PayAdminUser{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

// newTestRouter builds a router with the webui enabled and the default admin
// seeded. The audit sink goes to a temp file so grant tests can assert on it.
func newTestRouter(t *testing.T, token string) http.Handler {
	t.Helper()
	h, _ := newTestRouterFull(t, token)
	return h
}

// newTestRouterFull additionally returns the audit JSONL path for assertions.
func newTestRouterFull(t *testing.T, token string) (http.Handler, string) {
	t.Helper()
	setupTestDB(t)
	if err := repo.EnsureDefaultAdmin(); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	cfg := &config.Config{}
	cfg.WebUI.Enabled = true
	cfg.WebUI.Token = token
	cfg.Security.CORS.AllowOrigins = []string{"*"}
	cfg.Audit.File = filepath.Join(t.TempDir(), "pay-admin-audit.jsonl")
	audit := service.NewAudit(cfg.Audit.File)
	// Windows cannot delete a file with an open handle: close before TempDir
	// cleanup runs.
	t.Cleanup(func() { _ = audit.Close() })
	return New(cfg, service.NewGrantService(audit)), cfg.Audit.File
}

func doJSON(h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// adminHeaders returns a session-cookie header for the default admin account,
// logged in against the given router (each test router has its own session
// store, so the login must happen per instance).
func adminHeaders(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"`+repo.DefaultAdminPass+`"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login: got %d, body %s", w.Code, w.Body.String())
	}
	sid := sessionFromCookie(w)
	if sid == "" {
		t.Fatal("admin login returned no session cookie")
	}
	return map[string]string{"Cookie": webuiSessionCookie + "=" + sid}
}

// sessionFromCookie extracts the session id from a login Set-Cookie header.
func sessionFromCookie(w *httptest.ResponseRecorder) string {
	ck := w.Header().Get("Set-Cookie")
	prefix := webuiSessionCookie + "="
	i := bytes.Index([]byte(ck), []byte(prefix))
	if i < 0 {
		return ""
	}
	rest := ck[i+len(prefix):]
	if j := bytes.IndexByte([]byte(rest), ';'); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// ── username + password session flow ─────────────────────────────────

func TestWebuiLoginSessionFlow(t *testing.T) {
	h := newTestRouter(t, "")

	// Wrong password rejected; empty credentials rejected without throttle.
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"wrong"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("login wrong password: got %d, want 401", w.Code)
	}
	if w := doJSON(h, "POST", "/api/login", `{}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("login empty: got %d, want 401", w.Code)
	}

	// Correct credentials -> session issued (body + HttpOnly cookie).
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"`+repo.DefaultAdminPass+`"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login admin: got %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	var loginResp struct {
		OK      bool   `json:"ok"`
		Session string `json:"session"`
		User    struct {
			Username string `json:"username"`
			Role     string `json:"role"`
			IsAdmin  bool   `json:"is_admin"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &loginResp); err != nil {
		t.Fatalf("parse login response: %v", err)
	}
	if !loginResp.OK || loginResp.Session == "" || loginResp.User.Username != "admin" || !loginResp.User.IsAdmin {
		t.Fatalf("login response: %s", w.Body.String())
	}
	cookie := w.Header().Get("Set-Cookie")
	if !bytes.Contains([]byte(cookie), []byte(webuiSessionCookie+"="+loginResp.Session)) ||
		!bytes.Contains([]byte(cookie), []byte("HttpOnly")) ||
		!bytes.Contains([]byte(cookie), []byte("SameSite=Strict")) {
		t.Fatalf("login Set-Cookie malformed: %q", cookie)
	}

	// Session authorizes the API via both accepted headers AND the cookie.
	for name, hh := range map[string]map[string]string{
		"x-webui-token": {"X-WebUI-Token": loginResp.Session},
		"bearer":        {"Authorization": "Bearer " + loginResp.Session},
		"cookie":        {"Cookie": webuiSessionCookie + "=" + loginResp.Session},
	} {
		if w := doJSON(h, "GET", "/api/info", "", hh); w.Code != http.StatusOK {
			t.Fatalf("info with %s: got %d, want 200", name, w.Code)
		}
	}

	// Logout invalidates the session and clears the cookie.
	lo := doJSON(h, "POST", "/api/logout", "{}", map[string]string{"Cookie": webuiSessionCookie + "=" + loginResp.Session})
	if lo.Code != http.StatusOK {
		t.Fatalf("logout: got %d, want 200", lo.Code)
	}
	if w := doJSON(h, "GET", "/api/info", "", map[string]string{"X-WebUI-Token": loginResp.Session}); w.Code != http.StatusUnauthorized {
		t.Fatalf("info after logout: got %d, want 401", w.Code)
	}
}

// ── master token (API key) login path ────────────────────────────────

func TestWebuiLoginMasterToken(t *testing.T) {
	h := newTestRouter(t, "master-key")

	w := doJSON(h, "POST", "/api/login", `{"token":"master-key"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login master token: got %d, want 200", w.Code)
	}
	var resp struct {
		OK      bool   `json:"ok"`
		Session string `json:"session"`
		User    struct {
			IsAdmin bool `json:"is_admin"`
		} `json:"user"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.OK || resp.Session == "" || !resp.User.IsAdmin {
		t.Fatalf("master-token login response: %s", w.Body.String())
	}
	// The master token also authorizes /api/* directly.
	if w := doJSON(h, "GET", "/api/info", "", map[string]string{"X-WebUI-Token": "master-key"}); w.Code != http.StatusOK {
		t.Fatalf("info with raw master token: got %d, want 200", w.Code)
	}
}

// ── page gate: unauthenticated visitors never receive page HTML ─────

func TestWebuiPageGate(t *testing.T) {
	h := newTestRouter(t, "")

	// Unauthenticated: every page redirects to the login page...
	w := doJSON(h, "GET", "/", "", nil)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/login" {
		t.Fatalf("unauthenticated /: got %d Location=%q, want 302 /login", w.Code, w.Header().Get("Location"))
	}
	w = doJSON(h, "GET", "/orders", "", nil)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/login" {
		t.Fatalf("unauthenticated /orders: got %d, want 302 /login", w.Code)
	}
	// ...which serves the standalone login page (no app shell).
	w = doJSON(h, "GET", "/login", "", nil)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("支付后台")) {
		t.Fatalf("GET /login: got %d, want 200 login page", w.Code)
	}

	// The app shell is NOT reachable via the public static route.
	for _, asset := range []string{"/assets/app.css", "/assets/logo.svg", "/assets/login-art.svg"} {
		if w := doJSON(h, "GET", asset, "", nil); w.Code != http.StatusOK {
			t.Fatalf("%s: got %d, want 200", asset, w.Code)
		}
	}
	if w := doJSON(h, "GET", "/assets/index.html", "", nil); w.Code != http.StatusNotFound {
		t.Fatalf("/assets/index.html: got %d, want 404", w.Code)
	}

	// Login -> session cookie unlocks the pages; /login bounces back.
	ah := adminHeaders(t, h)
	if w := doJSON(h, "GET", "/", "", ah); w.Code != http.StatusFound || w.Header().Get("Location") != "/orders" {
		t.Fatalf("authenticated /: got %d, want 302 /orders", w.Code)
	}
	if w := doJSON(h, "GET", "/orders", "", ah); w.Code != http.StatusOK ||
		!bytes.Contains(w.Body.Bytes(), []byte(`id="app"`)) || !bytes.Contains(w.Body.Bytes(), []byte("订单号")) {
		t.Fatalf("authenticated /orders: got %d, want 200 orders page", w.Code)
	}
	if w := doJSON(h, "GET", "/login", "", ah); w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Fatalf("authenticated /login: got %d Location=%q, want 302 /", w.Code, w.Header().Get("Location"))
	}
}

// ── brute-force throttle ─────────────────────────────────────────────

func TestWebuiLoginThrottle(t *testing.T) {
	h := newTestRouter(t, "")

	for i := 0; i < webuiMaxFails; i++ {
		if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"nope"}`, nil); w.Code != http.StatusUnauthorized {
			t.Fatalf("throttle login %d: got %d, want 401", i, w.Code)
		}
	}
	// Window exhausted: even the CORRECT password is throttled (429).
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"`+repo.DefaultAdminPass+`"}`, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled correct login: got %d, want 429", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("429 response missing Retry-After header")
	}
	// Other /api/* endpoints share the same per-IP budget.
	if w := doJSON(h, "GET", "/api/info", "", nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled api access: got %d, want 429", w.Code)
	}
}

// ── CORS + security headers ──────────────────────────────────────────

func TestSecurityHeaders(t *testing.T) {
	setupTestDB(t)
	_ = repo.EnsureDefaultAdmin()
	cfg := &config.Config{}
	cfg.WebUI.Enabled = true
	cfg.Security.CORS.AllowOrigins = []string{"http://localhost:3000"}
	cfg.Audit.File = filepath.Join(t.TempDir(), "a.jsonl")
	h := New(cfg, service.NewGrantService(service.NewAudit(cfg.Audit.File)))

	// Baseline hardening on every response.
	w := doJSON(h, "GET", "/health", "", nil)
	for _, want := range [][2]string{
		{"X-Content-Type-Options", "nosniff"},
		{"X-Frame-Options", "DENY"},
		{"Content-Security-Policy", "frame-ancestors 'none'"},
		{"Referrer-Policy", "no-referrer"},
	} {
		if got := w.Header().Get(want[0]); got != want[1] {
			t.Fatalf("header %s = %q, want %q", want[0], got, want[1])
		}
	}

	// CORS allowlist: matching origin reflected, others ignored.
	req := httptest.NewRequest("OPTIONS", "/api/info", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req)
	if w2.Code != http.StatusNoContent || w2.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("CORS preflight: got %d %q, want 204 with origin echoed", w2.Code, w2.Header().Get("Access-Control-Allow-Origin"))
	}
	req2 := httptest.NewRequest("GET", "/api/info", nil)
	req2.Header.Set("Origin", "http://evil.example.com")
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, req2)
	if w3.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS must not echo a non-allowlisted origin")
	}
}

// ── role gating: viewer cannot grant or manage accounts ─────────────

func TestRoleGating(t *testing.T) {
	h := newTestRouter(t, "")

	// Create a viewer account via the admin session.
	ah := adminHeaders(t, h)
	if w := doJSON(h, "POST", "/api/users", `{"username":"ops","password":"ops-pass-123","role":"viewer"}`, ah); w.Code != http.StatusOK {
		t.Fatalf("create viewer: got %d, body %s", w.Code, w.Body.String())
	}
	vw := doJSON(h, "POST", "/api/login", `{"username":"ops","password":"ops-pass-123"}`, nil)
	if vw.Code != http.StatusOK {
		t.Fatalf("viewer login: got %d", vw.Code)
	}
	vh := map[string]string{"Cookie": webuiSessionCookie + "=" + sessionFromCookie(vw)}

	// Viewer CAN read pay-domain queries...
	if w := doJSON(h, "GET", "/api/orders", "", vh); w.Code != http.StatusOK {
		t.Fatalf("viewer list orders: got %d, want 200", w.Code)
	}
	// ...but CANNOT grant or touch accounts.
	if w := doJSON(h, "POST", "/api/grants", `{"uid":1,"duration_days":30,"reason":"x"}`, vh); w.Code != http.StatusForbidden {
		t.Fatalf("viewer grant: got %d, want 403", w.Code)
	}
	if w := doJSON(h, "GET", "/api/users", "", vh); w.Code != http.StatusForbidden {
		t.Fatalf("viewer list users: got %d, want 403", w.Code)
	}
}
