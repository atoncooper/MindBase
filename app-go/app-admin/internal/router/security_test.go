package router

// Login security tests: device fingerprint binding, session IP binding
// (exact / subnet), trusted-proxy client address resolution, the CORS header
// whitelist / hardening headers, and the login audit trail (failed attempt, new
// device, new address). Everything runs against in-memory SQLite with the
// shared console test harness.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/repo"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

const testAdminCredentials = `{"username":"admin","password":"app-admin"}`

// newSecurityTestEnv seeds the console admin account and returns a router with
// the supplied session / security policy.
func newSecurityTestEnv(t *testing.T, cfg *config.Config) *gin.Engine {
	t.Helper()
	setupTestDBs(t)
	if err := repo.EnsureSeedAdmin("admin", "app-admin"); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if cfg == nil {
		cfg = &config.Config{}
	}
	return New(cfg, Deps{
		Auth:    service.NewAuthServiceWithLimits(0, service.LoginLimits{}),
		Console: service.NewConsoleUserService(),
	})
}

// secDo performs one console request with an explicit TCP peer address and
// optional session cookie. Unsafe methods carry a same-origin Origin because the
// CSRF gate runs before the session gate.
func secDo(e http.Handler, method, path, body, peer string, headers map[string]string, cookie string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if peer != "" {
		req.RemoteAddr = peer
	}
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Origin", "http://"+req.Host)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func loginAttempt(e http.Handler, peer string, headers map[string]string) (int, string) {
	rec := secDo(e, http.MethodPost, "/api/login", testAdminCredentials, peer, headers, "")
	return rec.Code, sessionCookieOf(rec)
}

func mustLogin(t *testing.T, e http.Handler, peer string, headers map[string]string) string {
	t.Helper()
	code, token := loginAttempt(e, peer, headers)
	if code != http.StatusOK || token == "" {
		t.Fatalf("login: status %d, token %q", code, token)
	}
	return token
}

func getMe(e http.Handler, peer string, headers map[string]string, token string) *httptest.ResponseRecorder {
	return secDo(e, http.MethodGet, "/api/me", "", peer, headers, "admin_session="+token)
}

func auditCount(t *testing.T, action string) int64 {
	t.Helper()
	var n int64
	if err := db.DB.Model(&model.AdminAudit{}).Where("action = ?", action).Count(&n).Error; err != nil {
		t.Fatalf("count %s audits: %v", action, err)
	}
	return n
}

func auditRows(t *testing.T, action string) []model.AdminAudit {
	t.Helper()
	var rows []model.AdminAudit
	if err := db.DB.Where("action = ?", action).Find(&rows).Error; err != nil {
		t.Fatalf("load %s audits: %v", action, err)
	}
	return rows
}

// Device binding: a session is only valid for the device that created it.
func TestDeviceBindingStrict(t *testing.T) {
	cfg := &config.Config{}
	cfg.Session.DeviceBinding = "strict"
	e := newSecurityTestEnv(t, cfg)
	deviceA := "device-a-0123456789abcdef"
	deviceB := "device-b-0123456789abcdef"
	headersA := map[string]string{"X-Device-Id": deviceA}
	headersB := map[string]string{"X-Device-Id": deviceB}

	// Missing / malformed header is a client error, not a credential guess.
	for _, headers := range []map[string]string{nil, {"X-Device-Id": "short"}, {"X-Device-Id": strings.Repeat("!", 20)}} {
		rec := secDo(e, http.MethodPost, "/api/login", testAdminCredentials, "", headers, "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("missing/invalid device header: got %d body %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "X-Device-Id header required") {
			t.Fatalf("device header detail: %s", rec.Body.String())
		}
	}
	// Rejected logins never burn throttle budget: a valid login still succeeds.
	token := mustLogin(t, e, "", headersA)
	if rec := getMe(e, "", headersA, token); rec.Code != http.StatusOK {
		t.Fatalf("same device must pass: %d %s", rec.Code, rec.Body.String())
	}

	// Another device presenting the cookie is rejected and the row is deleted.
	if rec := getMe(e, "", headersB, token); rec.Code != http.StatusUnauthorized ||
		rec.Body.String() != `{"detail":"login required"}` {
		t.Fatalf("other device must be rejected: %d %s", rec.Code, rec.Body.String())
	}
	if bundle, _ := repo.GetSession(token); bundle != nil {
		t.Fatal("device-mismatch session must be deleted")
	}
	rows := auditRows(t, "session_device_mismatch")
	if len(rows) != 1 || rows[0].TargetType == nil || *rows[0].TargetType != "session" ||
		rows[0].Detail == nil || !strings.Contains(*rows[0].Detail, "device=") {
		t.Fatalf("device mismatch audit: %+v", rows)
	}

	// A fresh login from the second device works.
	tokenB := mustLogin(t, e, "", headersB)
	if rec := getMe(e, "", headersB, tokenB); rec.Code != http.StatusOK {
		t.Fatalf("re-login on the second device must work: %d", rec.Code)
	}
}

// Session IP binding: off-by-policy changes invalidate the session.
func TestSessionIPBindingExactAndSubnet(t *testing.T) {
	// exact: any address change invalidates.
	cfg := &config.Config{}
	cfg.Session.IPBinding = "exact"
	e := newSecurityTestEnv(t, cfg)
	token := mustLogin(t, e, "192.0.2.10:1234", nil)
	if rec := getMe(e, "192.0.2.10:5555", nil, token); rec.Code != http.StatusOK {
		t.Fatalf("same address must pass: %d %s", rec.Code, rec.Body.String())
	}
	if rec := getMe(e, "192.0.2.11:1234", nil, token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("different address must be rejected under exact binding: %d", rec.Code)
	}
	if bundle, _ := repo.GetSession(token); bundle != nil {
		t.Fatal("IP-mismatch session must be deleted")
	}
	rows := auditRows(t, "session_ip_mismatch")
	if len(rows) != 1 || rows[0].TargetType == nil || *rows[0].TargetType != "session" {
		t.Fatalf("IP mismatch audit: %+v", rows)
	}

	// subnet: same /24 passes (the sliding request does not end the session),
	// a different /24 fails.
	subnetCfg := &config.Config{}
	subnetCfg.Session.IPBinding = "subnet"
	subnetEngine := newSecurityTestEnv(t, subnetCfg)
	subnetToken := mustLogin(t, subnetEngine, "198.51.100.10:1234", nil)
	if rec := getMe(subnetEngine, "198.51.100.11:9999", nil, subnetToken); rec.Code != http.StatusOK {
		t.Fatalf("same /24 must pass under subnet binding: %d %s", rec.Code, rec.Body.String())
	}
	if rec := getMe(subnetEngine, "198.51.100.250:9999", nil, subnetToken); rec.Code != http.StatusOK {
		t.Fatalf("same /24 (different host) must pass: %d", rec.Code)
	}
	if rec := getMe(subnetEngine, "198.51.101.10:1234", nil, subnetToken); rec.Code != http.StatusUnauthorized {
		t.Fatalf("another /24 must be rejected under subnet binding: %d", rec.Code)
	}

	// A configured wider prefix is honoured (/16 instead of the default /24).
	wideCfg := &config.Config{}
	wideCfg.Session.IPBinding = "subnet"
	wideCfg.Session.IPv4Prefix = 16
	wideEngine := newSecurityTestEnv(t, wideCfg)
	wideToken := mustLogin(t, wideEngine, "172.20.1.10:1234", nil)
	if rec := getMe(wideEngine, "172.20.2.10:1234", nil, wideToken); rec.Code != http.StatusOK {
		t.Fatalf("same /16 must pass with ipv4_prefix=16: %d %s", rec.Code, rec.Body.String())
	}
}

// Trusted proxies: only a trusted peer may influence the client address, and
// the right-most non-trusted X-Forwarded-For entry wins.
func TestTrustedProxyResolvesClientIP(t *testing.T) {
	cfg := &config.Config{}
	cfg.Session.IPBinding = "exact"
	cfg.Security.TrustedProxies = []string{"172.16.0.0/12"}
	e := newSecurityTestEnv(t, cfg)

	forwarded := map[string]string{"X-Forwarded-For": "203.0.113.9"}
	token := mustLogin(t, e, "172.16.0.2:1234", forwarded)
	bundle, err := repo.GetSession(token)
	if err != nil || bundle == nil || bundle.Session.IP == nil || *bundle.Session.IP != "203.0.113.9" {
		t.Fatalf("session must store the forwarded client address: %+v err=%v", bundle, err)
	}
	// A client-prepended entry is skipped: the right-most non-trusted address is
	// the one that entered the proxy chain.
	spoofedPrefix := map[string]string{"X-Forwarded-For": "6.6.6.6, 203.0.113.9"}
	if rec := getMe(e, "172.16.0.2:1234", spoofedPrefix, token); rec.Code != http.StatusOK {
		t.Fatalf("forwarded client address must match: %d %s", rec.Code, rec.Body.String())
	}
	// A different forwarded client address breaks the exact binding.
	if rec := getMe(e, "172.16.0.2:1234", map[string]string{"X-Forwarded-For": "203.0.113.10"}, token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("changed forwarded address must be rejected: %d", rec.Code)
	}

	// X-Real-IP is the fallback when X-Forwarded-For is absent.
	realIPToken := mustLogin(t, e, "172.16.0.2:1234", map[string]string{"X-Real-IP": "203.0.113.20"})
	if bundle, _ := repo.GetSession(realIPToken); bundle == nil || bundle.Session.IP == nil ||
		*bundle.Session.IP != "203.0.113.20" {
		t.Fatalf("X-Real-IP fallback not applied: %+v", bundle)
	}

	// An untrusted peer cannot spoof its address: the peer itself is used.
	directToken := mustLogin(t, e, "198.51.100.5:1234", forwarded)
	if bundle, _ := repo.GetSession(directToken); bundle == nil || bundle.Session.IP == nil ||
		*bundle.Session.IP != "198.51.100.5" {
		t.Fatalf("untrusted peer must be its own client address: %+v", bundle)
	}
	// Rotating the forged header on the same direct connection stays valid.
	if rec := getMe(e, "198.51.100.5:1234", map[string]string{"X-Forwarded-For": "203.0.113.11"}, directToken); rec.Code != http.StatusOK {
		t.Fatalf("forged header from an untrusted peer must be ignored: %d %s", rec.Code, rec.Body.String())
	}
}

// CORS: the device header must be listed, Origin: null stays forbidden, and the
// hardening headers are present.
func TestCORSAllowsDeviceHeaderAndRejectsNullOrigin(t *testing.T) {
	cfg := &config.Config{}
	cfg.Security.CORS.AllowOrigins = []string{"https://admin-ui.example"}
	e := newSecurityTestEnv(t, cfg)

	preflight := func(origin, method, headers string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodOptions, "/api/login", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", method)
		req.Header.Set("Access-Control-Request-Headers", headers)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	rec := preflight("https://admin-ui.example", "POST", "content-type, x-device-id")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight with x-device-id must be accepted: %d %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "X-Device-Id") {
		t.Fatalf("Access-Control-Allow-Headers must list X-Device-Id: %q", got)
	}
	if rec := preflight("null", "POST", "content-type"); rec.Code != http.StatusForbidden {
		t.Fatalf("Origin: null must be rejected: %d", rec.Code)
	}
	if rec := preflight("https://attacker.example", "POST", "content-type"); rec.Code != http.StatusForbidden {
		t.Fatalf("unconfigured origin must be rejected: %d", rec.Code)
	}

	health := secDo(e, http.MethodGet, "/health", "", "", nil, "")
	if got := health.Header().Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
		t.Fatalf("Cross-Origin-Resource-Policy = %q", got)
	}
	if got := health.Header().Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
		t.Fatalf("Cross-Origin-Opener-Policy = %q", got)
	}
	if got := health.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

// Login audit trail: failures are recorded, and a device that never signed in
// before raises exactly one new-device warning (the very first login does not).
func TestLoginAuditsFailedAndNewDevice(t *testing.T) {
	cfg := &config.Config{}
	cfg.Session.DeviceBinding = "strict"
	e := newSecurityTestEnv(t, cfg)
	headersA := map[string]string{"X-Device-Id": "device-a-0123456789abcdef"}
	headersB := map[string]string{"X-Device-Id": "device-b-0123456789abcdef"}

	rec := secDo(e, http.MethodPost, "/api/login", `{"username":"admin","password":"wrong-password"}`, "", headersA, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password must be 401, got %d", rec.Code)
	}
	if got := auditCount(t, "login_failed"); got != 1 {
		t.Fatalf("failed login must be audited once, got %d", got)
	}
	failed := auditRows(t, "login_failed")
	if failed[0].AdminName != "admin" || failed[0].Detail == nil ||
		!strings.Contains(*failed[0].Detail, "reason=invalid_credentials") ||
		!strings.Contains(*failed[0].Detail, "device=") {
		t.Fatalf("failed login audit shape: %+v", failed[0])
	}

	// First successful login: the account has no login history yet, so no
	// first-sighting warning is emitted.
	mustLogin(t, e, "", headersA)
	if got := auditCount(t, "login_new_device"); got != 0 {
		t.Fatalf("first login must not raise a new-device warning, got %d", got)
	}
	if got := auditCount(t, "login_new_ip"); got != 0 {
		t.Fatalf("first login must not raise a new-IP warning, got %d", got)
	}

	// Same account, different device: exactly one new-device warning.
	mustLogin(t, e, "", headersB)
	if got := auditCount(t, "login_new_device"); got != 1 {
		t.Fatalf("second device must raise one new-device warning, got %d", got)
	}
	// Repeating the same device does not duplicate the warning.
	mustLogin(t, e, "", headersB)
	if got := auditCount(t, "login_new_device"); got != 1 {
		t.Fatalf("known device must not repeat the warning, got %d", got)
	}
	// Every login so far came from the same client address, so no new-IP
	// warning was raised.
	if got := auditCount(t, "login_new_ip"); got != 0 {
		t.Fatalf("same address must not raise a new-IP warning, got %d", got)
	}

	// A login from a different address raises exactly one new-IP warning while
	// the known device stays quiet.
	mustLogin(t, e, "203.0.113.50:1234", headersB)
	if got := auditCount(t, "login_new_ip"); got != 1 {
		t.Fatalf("new address must raise one new-IP warning, got %d", got)
	}
	if got := auditCount(t, "login_new_device"); got != 1 {
		t.Fatalf("known device must not repeat the warning after an address change, got %d", got)
	}
}
