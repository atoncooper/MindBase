package router

// Tests for the webui admin-console auth hardening: username+password login,
// session cookie flow, per-IP brute-force throttling, and the CORS / security
// response headers.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"app-task/internal/config"
	"app-task/internal/executor"
	"app-task/internal/service"
)

// newCorsTestRouter builds a router whose CORS allowlist contains a concrete
// origin (newWebUITestRouter uses "*" which never matches a real browser Origin).
func newCorsTestRouter(t *testing.T, token string) http.Handler {
	t.Helper()
	setupWebUITestDB(t)
	cfg := &config.Config{}
	cfg.WebUI.Enabled = true
	cfg.WebUI.Token = token
	cfg.Security.CORS.AllowOrigins = []string{"http://localhost:3000"}
	luaExec := executor.NewLuaExecutor(executor.LuaOptions{})
	emailSvc := service.NewEmailService(cfg)
	return New(service.NewTaskService(), emailSvc, luaExec, cfg)
}

// ── username + password session flow ─────────────────────────────────

func TestWebuiLoginSessionFlow(t *testing.T) {
	h := newWebUITestRouter(t, "")

	// Wrong password rejected; empty credentials rejected without throttle.
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"wrong"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("login wrong password: got %d, want 401", w.Code)
	}
	if w := doJSON(h, "POST", "/api/login", `{}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("login empty: got %d, want 401", w.Code)
	}

	// Correct credentials -> session issued (body + HttpOnly cookie).
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil)
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
	if w := doJSON(h, "GET", "/api/stats", "", map[string]string{"X-WebUI-Token": loginResp.Session}); w.Code != http.StatusOK {
		t.Fatalf("stats with session header: got %d, want 200", w.Code)
	}
	if w := doJSON(h, "GET", "/api/stats", "", map[string]string{"Authorization": "Bearer " + loginResp.Session}); w.Code != http.StatusOK {
		t.Fatalf("stats with bearer session: got %d, want 200", w.Code)
	}
	if w := doJSON(h, "GET", "/api/stats", "", map[string]string{"Cookie": webuiSessionCookie + "=" + loginResp.Session}); w.Code != http.StatusOK {
		t.Fatalf("stats with session cookie: got %d, want 200", w.Code)
	}

	// Logout invalidates the session and clears the cookie.
	lo := doJSON(h, "POST", "/api/logout", "{}", map[string]string{"Cookie": webuiSessionCookie + "=" + loginResp.Session})
	if lo.Code != http.StatusOK {
		t.Fatalf("logout: got %d, want 200", lo.Code)
	}
	if lo.Header().Get("Set-Cookie") == "" || !bytes.Contains([]byte(lo.Header().Get("Set-Cookie")), []byte("Max-Age=0")) {
		t.Fatalf("logout Set-Cookie should clear the session: %q", lo.Header().Get("Set-Cookie"))
	}
	if w := doJSON(h, "GET", "/api/stats", "", map[string]string{"X-WebUI-Token": loginResp.Session}); w.Code != http.StatusUnauthorized {
		t.Fatalf("stats after logout: got %d, want 401", w.Code)
	}
}

// ── master token (API key) login path ────────────────────────────────

func TestWebuiLoginMasterToken(t *testing.T) {
	h := newWebUITestRouter(t, "master-key")

	w := doJSON(h, "POST", "/api/login", `{"token":"master-key"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login master token: got %d, want 200", w.Code)
	}
	var resp struct {
		OK      bool   `json:"ok"`
		Session string `json:"session"`
		User    struct {
			Role    string `json:"role"`
			IsAdmin bool   `json:"is_admin"`
		} `json:"user"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.OK || resp.Session == "" || !resp.User.IsAdmin {
		t.Fatalf("master-token login response: %s", w.Body.String())
	}
}

// ── page gate: unauthenticated visitors never receive app HTML ─────

func TestWebuiPageGate(t *testing.T) {
	h := newWebUITestRouter(t, "")

	// Unauthenticated: console page redirects to the login page...
	w := doJSON(h, "GET", "/", "", nil)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/login" {
		t.Fatalf("unauthenticated /: got %d Location=%q, want 302 /login", w.Code, w.Header().Get("Location"))
	}
	// ...which serves the standalone login page (no app shell).
	w = doJSON(h, "GET", "/login", "", nil)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("登录控制台")) {
		t.Fatalf("GET /login: got %d, want 200 login page", w.Code)
	}

	// The app shell is NOT reachable via the public static route.
	if w := doJSON(h, "GET", "/assets/index.html", "", nil); w.Code != http.StatusNotFound {
		t.Fatalf("/assets/index.html: got %d, want 404", w.Code)
	}

	// Login -> session cookie unlocks the console page; /login bounces back.
	ah := adminHeaders(t, h)
	if w := doJSON(h, "GET", "/", "", ah); w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte(`id="app"`)) {
		t.Fatalf("authenticated /: got %d, want 200 app shell", w.Code)
	}
	if w := doJSON(h, "GET", "/login", "", ah); w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Fatalf("authenticated /login: got %d Location=%q, want 302 /", w.Code, w.Header().Get("Location"))
	}
	// Assets remain public (CSS/JS are not sensitive).
	if w := doJSON(h, "GET", "/assets/app.js", "", nil); w.Code != http.StatusOK {
		t.Fatalf("/assets/app.js: got %d, want 200", w.Code)
	}
}

// ── brute-force throttle ───────────────────────────────────────────

func TestWebuiLoginThrottle(t *testing.T) {
	h := newWebUITestRouter(t, "")

	// Exhaust the per-IP budget with failed logins...
	for i := 0; i < webuiMaxFails; i++ {
		if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"wrong"}`, nil); w.Code != http.StatusUnauthorized {
			t.Fatalf("failed login %d: got %d, want 401", i, w.Code)
		}
	}
	// ...then even the CORRECT credentials are throttled, on login and on the
	// API gate alike (shared counter, cannot bypass via another endpoint).
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("login after throttle: got %d, want 429", w.Code)
	}
	if w := doJSON(h, "GET", "/api/stats", "", adminHeadersIfOK(t, h)); w.Code != http.StatusTooManyRequests {
		t.Fatalf("stats after throttle: got %d, want 429", w.Code)
	}
}

// adminHeadersIfOK logs in but the response is discarded (used to show that
// even a valid login is throttled when the budget is exhausted).
func adminHeadersIfOK(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil)
	return map[string]string{"Cookie": webuiSessionCookie + "=" + sessionFromCookie(w)}
}

// ── CORS + security headers ────────────────────────────────────────

func TestCorsAndSecurityHeaders(t *testing.T) {
	h := newCorsTestRouter(t, "secret-token")

	// Preflight from an allowed origin must echo the origin and allow the
	// console's own header so cross-origin browser clients pass preflight.
	req := httptest.NewRequest("OPTIONS", "/api/stats", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Headers", "x-webui-token")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight: got %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("preflight ACAO: got %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Headers"); !bytes.Contains([]byte(got), []byte("X-WebUI-Token")) {
		t.Fatalf("preflight allow-headers missing X-WebUI-Token: %q", got)
	}
	if got := w.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("preflight Vary: got %q, want Origin", got)
	}

	// Disallowed origin gets no CORS grant.
	req = httptest.NewRequest("GET", "/api/stats", nil)
	req.Header.Set("Origin", "http://evil.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin ACAO: got %q, want empty", got)
	}

	// Security headers on API responses.
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "no-store",
	} {
		if got := w.Header().Get(k); got != want {
			t.Fatalf("security header %s: got %q, want %q", k, got, want)
		}
	}
	if got := w.Header().Get("Content-Security-Policy"); got != "frame-ancestors 'none'" {
		t.Fatalf("CSP: got %q", got)
	}

	// XFF spoofing must not change the throttle key (no trusted proxies).
	req = httptest.NewRequest("GET", "/api/stats", nil)
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.Header.Set("X-WebUI-Token", "wrong")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("xff request: got %d, want 401", w.Code)
	}
}
