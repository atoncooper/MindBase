package router

// Tests for the SSR (html/template) page flow: form login/logout, page
// rendering, and the POST-redirect-GET form endpoints (grants / users).

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"
)

// formPOST submits an application/x-www-form-urlencoded request.
func formPOST(h http.Handler, path string, form url.Values, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// ── form login / logout flow ────────────────────────────────────────

func TestSSRLoginFlow(t *testing.T) {
	h := newTestRouter(t, "")

	// Wrong credentials re-render the login page with an error (no session).
	form := url.Values{"username": {"admin"}, "password": {"nope"}}
	w := formPOST(h, "/login", form, nil)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("用户名或密码不正确")) {
		t.Fatalf("form login wrong: got %d, want 200 with error box", w.Code)
	}

	// Correct credentials -> 303 redirect with session cookie.
	form.Set("password", repo.DefaultAdminPass)
	w = formPOST(h, "/login", form, nil)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" {
		t.Fatalf("form login: got %d Location=%q, want 303 /", w.Code, w.Header().Get("Location"))
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), webuiSessionCookie+"=") {
		t.Fatalf("form login missing session cookie: %q", w.Header().Get("Set-Cookie"))
	}
	sid := sessionFromCookie(w)

	// The cookie unlocks pages...
	ah := map[string]string{"Cookie": webuiSessionCookie + "=" + sid}
	if w := doJSON(h, "GET", "/orders", "", ah); w.Code != http.StatusOK {
		t.Fatalf("orders after form login: got %d", w.Code)
	}

	// ...and POST /logout invalidates it.
	w = formPOST(h, "/logout", url.Values{}, ah)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/login" {
		t.Fatalf("form logout: got %d, want 303 /login", w.Code)
	}
	if w := doJSON(h, "GET", "/orders", "", ah); w.Code != http.StatusFound {
		t.Fatalf("orders after logout: got %d, want 302 /login", w.Code)
	}
}

// ── page rendering with seeded data ─────────────────────────────────

func seedSSRData(t *testing.T) {
	t.Helper()
	now := time.Now()
	seedOrder(t, "PO-S1", 7001, "DELIVERED", "ALIPAY", 1800, now)
	seedCallback(t, "PO-S1", "VALID", "ACCEPTED")
	seedCallback(t, "PO-S1", "INVALID", "IGNORED")
	lastOrder := "PO-S1"
	if err := db.DB.Create(&model.PayMembership{
		UID: 7001, Tier: "VIP", ExpireAt: now.Add(10 * 24 * time.Hour),
		LastOrderNo: &lastOrder, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	if err := db.DB.Create(&model.PayMembershipEvent{
		UID: 7001, Type: "ADMIN_GRANT", Days: 30,
		ExpireBefore: now, ExpireAfter: now.Add(10 * 24 * time.Hour),
		Reason: strPtr("[admin] 客诉补偿"), CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed event: %v", err)
	}
	if err := db.DB.Create(&model.PayProduct{
		Code: "VIP_MONTHLY", Title: "VIP 月卡", DurationDays: 30,
		PriceCents: 1800, Status: "ACTIVE", CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed product: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func TestSSRPagesRender(t *testing.T) {
	h := newTestRouter(t, "")
	seedSSRData(t)
	ah := adminHeaders(t, h)

	// Orders: table carries the seeded order (link) and status dot.
	w := doJSON(h, "GET", "/orders?status=DELIVERED&uid=7001", "", ah)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("PO-S1")) ||
		!bytes.Contains(w.Body.Bytes(), []byte("st-green")) {
		t.Fatalf("orders page: got %d (filters applied?) body=%s", w.Code, truncate(w.Body.String()))
	}

	// Order detail: description list + callback rows.
	w = doJSON(h, "GET", "/orders/PO-S1", "", ah)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("渠道回调流水")) ||
		!bytes.Contains(w.Body.Bytes(), []byte("¥18.00")) {
		t.Fatalf("order detail page: got %d body=%s", w.Code, truncate(w.Body.String()))
	}

	// Unknown order -> shell 404 with flash.
	w = doJSON(h, "GET", "/orders/PO-NOPE", "", ah)
	if w.Code != http.StatusNotFound || !bytes.Contains(w.Body.Bytes(), []byte("订单不存在")) {
		t.Fatalf("unknown order page: got %d, want 404 shell", w.Code)
	}

	// datetime-local filter: picker format ("2026-09-01T00:00") parses without
	// a warn flash and refills the input in picker-compatible form.
	w = doJSON(h, "GET", "/orders?created_from="+url.QueryEscape("2026-09-01T00:00"), "", ah)
	if w.Code != http.StatusOK || bytes.Contains(w.Body.Bytes(), []byte("格式不正确")) ||
		!bytes.Contains(w.Body.Bytes(), []byte(`name="created_from" value="2026-09-01T00:00"`)) {
		t.Fatalf("datetime-local filter parse/refill failed")
	}

	// Memberships / member events / events / products / grants.
	for _, path := range []string{"/memberships", "/memberships/7001/events", "/events?type=ADMIN_GRANT", "/products", "/grants"} {
		if w := doJSON(h, "GET", path, "", ah); w.Code != http.StatusOK {
			t.Fatalf("GET %s: got %d, want 200", path, w.Code)
		}
	}
	if w := doJSON(h, "GET", "/memberships?uid=7001", "", ah); w.Code != http.StatusOK ||
		!bytes.Contains(w.Body.Bytes(), []byte("生效中")) {
		t.Fatalf("membership lookup page: got %d", w.Code)
	}
	// Admin grant page must render the full form (guards against partial
	// template execution, e.g. field-promotion failures).
	if w := doJSON(h, "GET", "/grants", "", ah); w.Code != http.StatusOK ||
		!bytes.Contains(w.Body.Bytes(), []byte("确认补偿开通")) {
		t.Fatalf("grants page missing grant form (partial render?)")
	}
}

func truncate(s string) string {
	if len(s) > 400 {
		return s[:400]
	}
	return s
}

// ── grant form (POST-redirect-GET) ──────────────────────────────────

func TestSSRGrantForm(t *testing.T) {
	h, auditPath := newTestRouterFull(t, "")
	ah := adminHeaders(t, h)

	form := url.Values{"uid": {"8001"}, "duration_days": {"14"}, "reason": {"工单补偿"}}
	w := formPOST(h, "/grants", form, ah)
	loc := w.Header().Get("Location")
	if w.Code != http.StatusSeeOther || !strings.Contains(loc, "/grants?ok=") {
		t.Fatalf("grant form: got %d Location=%q, want 303 /grants?ok=...", w.Code, loc)
	}
	m, err := repo.GetMembershipByUID(8001)
	if err != nil || m == nil {
		t.Fatalf("membership after form grant: %v %v", m, err)
	}
	if b, _ := os.ReadFile(auditPath); !bytes.Contains(b, []byte(`"operator":"admin"`)) {
		t.Fatalf("audit jsonl missing grant entry: %s", b)
	}

	// Invalid input -> redirect with err flash, nothing written.
	form.Set("duration_days", "0")
	w = formPOST(h, "/grants", form, ah)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "err=") {
		t.Fatalf("grant form invalid: got %d Location=%q", w.Code, w.Header().Get("Location"))
	}
	if m2, _ := repo.GetMembershipByUID(8002); m2 != nil {
		t.Fatal("invalid grant must not write membership")
	}

	// Viewer is rejected with an err flash.
	vh := viewerHeaders(t, h)
	w = formPOST(h, "/grants", url.Values{"uid": {"8003"}, "duration_days": {"7"}, "reason": {"x"}}, vh)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "err=") {
		t.Fatalf("viewer grant form: got %d Location=%q", w.Code, w.Header().Get("Location"))
	}
}

// ── user management forms ───────────────────────────────────────────

func TestSSRUserForms(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)

	// Create viewer via form.
	w := formPOST(h, "/users",
		url.Values{"username": {"ops2"}, "password": {"ops-pass-123"}, "role": {"viewer"}}, ah)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("user create form: got %d Location=%q", w.Code, w.Header().Get("Location"))
	}
	if u, _ := repo.GetUserByUsername("ops2"); u == nil || u.Role != repo.RoleViewer {
		t.Fatal("viewer account not created")
	}

	// Duplicate -> err flash.
	w = formPOST(h, "/users",
		url.Values{"username": {"ops2"}, "password": {"ops-pass-123"}}, ah)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "err=") {
		t.Fatalf("duplicate user form: got %d Location=%q", w.Code, w.Header().Get("Location"))
	}

	// Users page renders the accounts (admin sees tab + rows).
	if w := doJSON(h, "GET", "/users", "", ah); w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("ops2")) {
		t.Fatalf("users page: got %d", w.Code)
	}

	// Viewer cannot open the users page (redirected with err flash).
	vh := viewerHeaders(t, h)
	if w := doJSON(h, "GET", "/users", "", vh); w.Code != http.StatusSeeOther {
		t.Fatalf("viewer users page: got %d, want 303", w.Code)
	}
}

// viewerHeaders logs in as the seeded-by-test viewer account (created via the
// admin API) and returns cookie headers.
func viewerHeaders(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	ah := adminHeaders(t, h)
	if w := doJSON(h, "POST", "/api/users", `{"username":"vw","password":"vw-pass-123","role":"viewer"}`, ah); w.Code != http.StatusOK {
		t.Fatalf("seed viewer: got %d, body %s", w.Code, w.Body.String())
	}
	w := doJSON(h, "POST", "/api/login", `{"username":"vw","password":"vw-pass-123"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("viewer login: got %d", w.Code)
	}
	return map[string]string{"Cookie": webuiSessionCookie + "=" + sessionFromCookie(w)}
}
