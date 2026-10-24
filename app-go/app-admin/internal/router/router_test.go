// Router guard tests: the role gate must keep moderation writes admin-only,
// /health must fail closed when the DB is unreachable, and every failure must
// speak the {"detail": ...} error contract (plan/1.0.16).
package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-admin/internal/config"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

func newTestRouter() *gin.Engine {
	cfg := &config.Config{Security: config.SecurityConfig{}}
	return New(cfg,
		service.NewAuthService(0),
		service.NewUserService(),
		service.NewShareService(nil),
		service.NewAuditService())
}

func hit(e *gin.Engine, path string) (int, string) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	e.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestHealthFailsClosedWithoutDB(t *testing.T) {
	e := newTestRouter()
	code, body := hit(e, "/health")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("health without DB must be 503, got %d body=%s", code, body)
	}
	if body != `{"detail":"database unavailable"}` {
		t.Fatalf("unexpected health body: %s", body)
	}
}

// cookie-free requests must be 401 UNAUTHORIZED with the detail contract
// (no DB round-trip happens before this check).
func TestAPI401WithoutCookie(t *testing.T) {
	e := newTestRouter()
	for _, path := range []string{"/api/me", "/api/users", "/api/shares", "/api/audit"} {
		code, body := hit(e, path)
		if code != http.StatusUnauthorized {
			t.Fatalf("%s without session must be 401, got %d", path, code)
		}
		if body != `{"detail":"login required"}` {
			t.Fatalf("%s body must be detail-shaped, got %s", path, body)
		}
	}
}

func TestIPAllowlistUsesPeerAddressNotForwardedHeader(t *testing.T) {
	cfg := &config.Config{}
	cfg.Security.IPAllowlist = []string{"192.0.2.0/24", "2001:db8::1"}
	e := New(cfg,
		service.NewAuthService(0),
		service.NewUserService(),
		service.NewShareService(nil),
		service.NewAuditService())

	request := func(remoteAddr, forwardedFor string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://admin.example/api/me", nil)
		req.RemoteAddr = remoteAddr
		if forwardedFor != "" {
			req.Header.Set("X-Forwarded-For", forwardedFor)
		}
		e.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := request("192.0.2.25:1234", "198.51.100.1"); got != http.StatusUnauthorized {
		t.Fatalf("allowed peer should reach session gate, got %d", got)
	}
	if got := request("198.51.100.25:1234", "192.0.2.25"); got != http.StatusForbidden {
		t.Fatalf("spoofed X-Forwarded-For must not bypass allowlist, got %d", got)
	}
	if got := request("[2001:db8::1]:1234", ""); got != http.StatusUnauthorized {
		t.Fatalf("allowed IPv6 peer should reach session gate, got %d", got)
	}
}

func TestOriginGateAllowsSameOriginAndConfiguredSPAOnly(t *testing.T) {
	cfg := &config.Config{}
	cfg.Security.CORS.AllowOrigins = []string{"https://admin-ui.example"}
	e := New(cfg,
		service.NewAuthService(0),
		service.NewUserService(),
		service.NewShareService(nil),
		service.NewAuditService())

	request := func(host, method, origin string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "https://"+host+"/api/login", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		e.ServeHTTP(rec, req)
		return rec
	}

	if rec := request("api.example", http.MethodPost, "https://api.example"); rec.Code != http.StatusBadRequest {
		t.Fatalf("same-origin POST should reach login handler, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request("api.example", http.MethodPost, "https://admin-ui.example"); rec.Code != http.StatusBadRequest {
		t.Fatalf("configured SPA origin should reach login handler, got %d body=%s", rec.Code, rec.Body.String())
	} else if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://admin-ui.example" {
		t.Fatalf("configured origin response header mismatch: %q", got)
	}
	if rec := request("api.example", http.MethodPost, "https://attacker.example"); rec.Code != http.StatusForbidden {
		t.Fatalf("unconfigured origin must be rejected, got %d", rec.Code)
	}
	if rec := request("api.example", http.MethodPost, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("unsafe request without Origin must be rejected, got %d", rec.Code)
	}
}

func TestOriginGateValidatesPreflight(t *testing.T) {
	cfg := &config.Config{}
	cfg.Security.CORS.AllowOrigins = []string{"https://admin-ui.example"}
	e := New(cfg,
		service.NewAuthService(0),
		service.NewUserService(),
		service.NewShareService(nil),
		service.NewAuditService())

	request := func(method, headers string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "https://api.example/api/login", nil)
		req.Header.Set("Origin", "https://admin-ui.example")
		req.Header.Set("Access-Control-Request-Method", method)
		req.Header.Set("Access-Control-Request-Headers", headers)
		e.ServeHTTP(rec, req)
		return rec
	}

	if rec := request("POST", "content-type"); rec.Code != http.StatusNoContent {
		t.Fatalf("valid preflight should be accepted, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request("DELETE", "content-type"); rec.Code != http.StatusForbidden {
		t.Fatalf("unsupported preflight method must be rejected, got %d", rec.Code)
	}
	if rec := request("POST", "x-evil-header"); rec.Code != http.StatusForbidden {
		t.Fatalf("unsupported preflight header must be rejected, got %d", rec.Code)
	}
}

// requireAdmin gate: a viewer identity must be rejected with 403 while an
// admin passes - this is the (ban / unban / approve) red line.
func TestRequireAdminGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	seedRole := func(c *gin.Context) {
		c.Set(ctxIdentity, adminIdentity{Role: c.GetHeader("X-Test-Role")})
		c.Next()
	}
	e.POST("/m", seedRole, requireAdmin(), func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/m", nil)
	req.Header.Set("X-Test-Role", "viewer")
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer must be rejected with 403, got %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/m", nil)
	req.Header.Set("X-Test-Role", "admin")
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin must pass, got %d body=%s", rec.Code, rec.Body.String())
	}
}
