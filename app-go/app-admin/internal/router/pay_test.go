package router

// Payment-operations console tests: query endpoints, the
// compensation grant fund write, and the refund-review proxy. Everything runs
// against TWO in-memory SQLite databases (main admin_* tables + app_pay row
// mappings), mirroring the production split without MySQL.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/payops"
	"app-admin/internal/repo"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// ── shared test harness ─────────────────────────────────────────────────

// setupTestDBs swaps BOTH global GORM handles for fresh in-memory SQLite
// databases: the main DB gets the admin_* own tables, the pay DB gets the
// pay_* row mappings (production MySQL never migrates them, but the test tables
// mirror the Java schema). Previous handles are restored on cleanup so tests
// that expect "no database" keep working regardless of order.
func setupTestDBs(t *testing.T) {
	t.Helper()
	prevMain, prevPay := db.DB, db.PayDB
	db.DB = openTestSQLite(t, &model.AdminUser{}, &model.AdminSession{}, &model.AdminAudit{})
	db.PayDB = openTestSQLite(t,
		&model.PayOrder{}, &model.PayMembership{}, &model.PayMembershipEvent{},
		&model.PayCallbackLog{}, &model.PayProduct{}, &model.PayRefundApproval{},
	)
	t.Cleanup(func() { db.DB, db.PayDB = prevMain, prevPay })
}

func openTestSQLite(t *testing.T, models ...any) *gorm.DB {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("sqlite handle: %v", err)
	}
	// One connection keeps the :memory: database identical across queries.
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(models...); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}
	return gdb
}

// apiDo performs one console request. Unsafe methods carry a same-origin Origin
// header because the browser CSRF gate runs before the session gate (the real
// SPA always sends it).
func apiDo(e http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Origin", "http://"+req.Host)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

// sessionCookieOf extracts the admin_session value from a login response.
func sessionCookieOf(w *httptest.ResponseRecorder) string {
	const prefix = "admin_session="
	ck := w.Header().Get("Set-Cookie")
	i := strings.Index(ck, prefix)
	if i < 0 {
		return ""
	}
	rest := ck[i+len(prefix):]
	if j := strings.IndexByte(rest, ';'); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// loginAs logs in and returns the Cookie header.
func loginAs(t *testing.T, e http.Handler, username, password string) map[string]string {
	t.Helper()
	w := apiDo(e, http.MethodPost, "/api/login",
		fmt.Sprintf("{\"username\":%q,\"password\":%q}", username, password), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login %s: got %d, body %s", username, w.Code, w.Body.String())
	}
	token := sessionCookieOf(w)
	if token == "" {
		t.Fatalf("login %s returned no session cookie", username)
	}
	return map[string]string{"Cookie": "admin_session=" + token}
}

func loginAsAdmin(t *testing.T, e http.Handler) map[string]string {
	t.Helper()
	return loginAs(t, e, "admin", "app-admin")
}

func decodeJSON(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("parse %q: %v", body, err)
	}
}

// payTestOptions configures the payment-console test router.
type payTestOptions struct {
	payDisabled   bool // no Pay deps: /api/pay/** must answer 503
	opsBaseURL    string
	opsKey        string
	refundEnabled bool
	grantCaps     service.GrantCaps
}

type payTestEnv struct {
	engine    *gin.Engine
	headers   map[string]string
	auditPath string
	cfg       *config.Config
}

// newPayTestEnv builds the unified console with the payment module wired to
// the SQLite pay DB (or deliberately disabled) and logs in as the seeded admin.
func newPayTestEnv(t *testing.T, opt payTestOptions) *payTestEnv {
	t.Helper()
	setupTestDBs(t)
	if err := repo.EnsureSeedAdmin("admin", "app-admin"); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	cfg := &config.Config{}
	cfg.Pay.AuditFile = filepath.Join(t.TempDir(), "pay-audit.jsonl")
	cfg.Pay.Ops.BaseURL = opt.opsBaseURL
	cfg.Pay.Ops.Key = opt.opsKey
	cfg.Pay.Ops.RefundReviewEnabled = opt.refundEnabled
	if !opt.payDisabled {
		cfg.PayRDBMS.URL = "mysql+aiomysql://u:p@pay-mysql:3306/app_pay"
	}
	audit := service.NewPayAudit(cfg.Pay.AuditFile)
	t.Cleanup(func() { _ = audit.Close() })

	deps := Deps{
		Auth:    service.NewAuthService(0),
		Console: service.NewConsoleUserService(),
	}
	if !opt.payDisabled {
		deps.Pay = service.NewPayQueryService()
		deps.Grants = service.NewPayGrantServiceWithAudit(audit, opt.grantCaps, repo.RecordAudit)
		deps.Ops = payops.New(opt.opsBaseURL, opt.opsKey, 5)
		deps.PayAudit = audit
	}
	e := New(cfg, deps)
	return &payTestEnv{
		engine:    e,
		headers:   loginAsAdmin(t, e),
		auditPath: cfg.Pay.AuditFile,
		cfg:       cfg,
	}
}

func (env *payTestEnv) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return apiDo(env.engine, method, path, body, env.headers)
}

// ── seeding helpers ─────────────────────────────────────────────────────

func seedPayOrder(t *testing.T, orderNo string, uid int64, status, channel string, cents int64, createdAt time.Time) *model.PayOrder {
	t.Helper()
	o := &model.PayOrder{
		OrderNo:      orderNo,
		UID:          uid,
		SkuCode:      "VIP_MONTHLY",
		ProductTitle: "VIP 月卡",
		DurationDays: 30,
		AmountCents:  cents,
		Channel:      channel,
		Status:       status,
		Version:      1,
		ExpiresAt:    createdAt.Add(30 * time.Minute),
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	}
	if err := db.PayDB.Create(o).Error; err != nil {
		t.Fatalf("seed order: %v", err)
	}
	return o
}

func seedPayCallback(t *testing.T, orderNo, sig, handle string) {
	t.Helper()
	payload := "{\"masked\":\"...\"}"
	cb := &model.PayCallbackLog{
		OrderNo:         orderNo,
		Channel:         "ALIPAY",
		PayloadMasked:   &payload,
		SignatureResult: sig,
		HandleResult:    handle,
		CreatedAt:       time.Now(),
	}
	if err := db.PayDB.Create(cb).Error; err != nil {
		t.Fatalf("seed callback: %v", err)
	}
}

func seedPayMembership(t *testing.T, uid int64, tier string, expire time.Time, lastOrder *string) {
	t.Helper()
	now := time.Now()
	if err := db.PayDB.Create(&model.PayMembership{
		UID: uid, Tier: tier, ExpireAt: expire, LastOrderNo: lastOrder,
		CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed membership: %v", err)
	}
}

// ── health ──────────────────────────────────────────────────────────────

func TestHealthPayStatusMatrix(t *testing.T) {
	// Main database unavailable -> 503 database unavailable (existing contract).
	setupTestDBs(t)
	db.DB = nil
	if w := apiDo(New(&config.Config{}, Deps{}), http.MethodGet, "/health", "", nil); w.Code != http.StatusServiceUnavailable ||
		w.Body.String() != `{"detail":"database unavailable"}` {
		t.Fatalf("main db down: got %d %s", w.Code, w.Body.String())
	}

	// pay_rdbms.url configured but the pay connection is not available -> 503.
	setupTestDBs(t)
	db.PayDB = nil
	cfg := &config.Config{}
	cfg.PayRDBMS.URL = "mysql+aiomysql://u:p@pay-mysql:3306/app_pay"
	w := apiDo(New(cfg, Deps{}), http.MethodGet, "/health", "", nil)
	if w.Code != http.StatusServiceUnavailable || w.Body.String() != `{"detail":"pay database unavailable"}` {
		t.Fatalf("pay db configured but down: got %d %s", w.Code, w.Body.String())
	}

	// Both databases healthy -> pay:"ok".
	setupTestDBs(t)
	cfg = &config.Config{}
	cfg.PayRDBMS.URL = "mysql+aiomysql://u:p@pay-mysql:3306/app_pay"
	w = apiDo(New(cfg, Deps{}), http.MethodGet, "/health", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("healthy: got %d %s", w.Code, w.Body.String())
	}
	var health struct {
		Status  string `json:"status"`
		Service string `json:"service"`
		Pay     string `json:"pay"`
	}
	decodeJSON(t, w.Body.String(), &health)
	if health.Status != "healthy" || health.Service != "app-admin" || health.Pay != "ok" {
		t.Fatalf("healthy body: %s", w.Body.String())
	}

	// Pay intentionally unconfigured -> 200 pay:"disabled" (not an outage).
	setupTestDBs(t)
	db.PayDB = nil // no second connection configured
	cfg = &config.Config{}
	w = apiDo(New(cfg, Deps{}), http.MethodGet, "/health", "", nil)
	decodeJSON(t, w.Body.String(), &health)
	if w.Code != http.StatusOK || health.Pay != "disabled" {
		t.Fatalf("pay disabled health: got %d %s", w.Code, w.Body.String())
	}
}

// ── pay module gate ─────────────────────────────────────────────────────

func TestPayRoutesDisabledReturns503(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{payDisabled: true})

	// Session gate wins first: anonymous callers get 401, not the pay hint.
	if w := apiDo(env.engine, http.MethodGet, "/api/pay/orders", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous pay call must be 401, got %d", w.Code)
	}
	w := env.do(t, http.MethodGet, "/api/pay/orders", "")
	if w.Code != http.StatusServiceUnavailable || w.Body.String() != `{"detail":"支付管理未配置"}` {
		t.Fatalf("disabled pay module must answer 503 detail, got %d %s", w.Code, w.Body.String())
	}
	// Every pay route shares the gate.
	for _, path := range []string{"/api/pay/memberships", "/api/pay/events", "/api/pay/products", "/api/pay/refunds"} {
		if w := env.do(t, http.MethodGet, path, ""); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s must be 503 when pay is disabled, got %d", path, w.Code)
		}
	}
	// Account management is independent of the payment DB and keeps working.
	if w := env.do(t, http.MethodGet, "/api/console/users", ""); w.Code != http.StatusOK {
		t.Fatalf("console users must work with pay disabled, got %d %s", w.Code, w.Body.String())
	}
}

// ── orders ──────────────────────────────────────────────────────────────

func TestPayOrdersListAndFilters(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	now := time.Now()
	seedPayOrder(t, "PO-A", 1001, "DELIVERED", "ALIPAY", 1800, now.Add(-3*time.Hour))
	seedPayOrder(t, "PO-B", 1001, "CLOSED", "MOCK", 4500, now.Add(-2*time.Hour))
	seedPayOrder(t, "PO-C", 1002, "CREATED", "ALIPAY", 15800, now.Add(-1*time.Hour))
	// Channel trade number on PO-C for the tradeNo filter / detail fallback.
	trade := "TRADE-C"
	if err := db.PayDB.Model(&model.PayOrder{}).Where("order_no = ?", "PO-C").
		Update("channel_trade_no", trade).Error; err != nil {
		t.Fatalf("seed trade no: %v", err)
	}

	type orderPage struct {
		Items []struct {
			OrderNo        string  `json:"orderNo"`
			UID            string  `json:"uid"`
			SkuCode        string  `json:"skuCode"`
			ProductTitle   string  `json:"productTitle"`
			DurationDays   int     `json:"durationDays"`
			AmountCents    int64   `json:"amountCents"`
			Channel        string  `json:"channel"`
			Status         string  `json:"status"`
			Version        int     `json:"version"`
			ChannelTradeNo *string `json:"channelTradeNo"`
			PaidAt         *string `json:"paidAt"`
			ClosedAt       *string `json:"closedAt"`
			ExpiresAt      string  `json:"expiresAt"`
			CreatedAt      string  `json:"createdAt"`
			UpdatedAt      string  `json:"updatedAt"`
		} `json:"items"`
		Total    int64 `json:"total"`
		Page     int   `json:"page"`
		PageSize int   `json:"pageSize"`
	}

	w := env.do(t, http.MethodGet, "/api/pay/orders", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list orders: got %d, body %s", w.Code, w.Body.String())
	}
	// uid is a JSON STRING (bigint precision safety), not a number.
	if !strings.Contains(w.Body.String(), `"uid":"1002"`) {
		t.Fatalf("uid must serialise as a string: %s", w.Body.String())
	}
	// Nullable columns serialise as null, not "".
	if !strings.Contains(w.Body.String(), `"paidAt":null`) || !strings.Contains(w.Body.String(), `"failReason":null`) {
		t.Fatalf("nullable columns must be null: %s", w.Body.String())
	}
	var page orderPage
	decodeJSON(t, w.Body.String(), &page)
	if page.Total != 3 || len(page.Items) != 3 || page.Page != 1 || page.PageSize != 20 {
		t.Fatalf("orders envelope: %s", w.Body.String())
	}
	// ORDER BY id DESC: newest inserted (PO-C) first.
	if page.Items[0].OrderNo != "PO-C" || page.Items[2].OrderNo != "PO-A" {
		t.Fatalf("orders must be newest first: %s", w.Body.String())
	}
	if page.Items[0].AmountCents != 15800 || page.Items[0].Channel != "ALIPAY" ||
		page.Items[0].SkuCode != "VIP_MONTHLY" || page.Items[0].ProductTitle != "VIP 月卡" ||
		page.Items[0].DurationDays != 30 || page.Items[0].Version != 1 ||
		page.Items[0].ExpiresAt == "" || page.Items[0].CreatedAt == "" || page.Items[0].UpdatedAt == "" {
		t.Fatalf("order item fields: %+v", page.Items[0])
	}
	if page.Items[0].ChannelTradeNo == nil || *page.Items[0].ChannelTradeNo != trade {
		t.Fatalf("channelTradeNo: %+v", page.Items[0].ChannelTradeNo)
	}

	// Filters.
	checkTotal := func(query string, want int64) {
		t.Helper()
		w := env.do(t, http.MethodGet, "/api/pay/orders?"+query, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s: got %d, body %s", query, w.Code, w.Body.String())
		}
		var p orderPage
		decodeJSON(t, w.Body.String(), &p)
		if p.Total != want {
			t.Fatalf("%s: total=%d, want %d (body %s)", query, p.Total, want, w.Body.String())
		}
	}
	checkTotal("uid=1001", 2)
	checkTotal("status=CLOSED", 1)
	checkTotal("channel=MOCK", 1)
	checkTotal("sku=VIP_MONTHLY", 3)
	checkTotal("orderNo=PO-C", 1)
	checkTotal("tradeNo="+trade, 1)
	checkTotal("createdFrom="+url.QueryEscape(now.Add(-150*time.Minute).Format(time.RFC3339)), 2)
	checkTotal("createdFrom=2020-01-01", 3)
	checkTotal("createdTo=2020-01-01", 0)
	checkTotal("createdTo="+url.QueryEscape(now.Add(24*time.Hour).Format("2006-01-02")), 3)

	// Pagination + validation.
	if w := env.do(t, http.MethodGet, "/api/pay/orders?page=2&pageSize=2", ""); w.Code != http.StatusOK {
		t.Fatalf("page 2: got %d", w.Code)
	} else {
		var p orderPage
		decodeJSON(t, w.Body.String(), &p)
		if len(p.Items) != 1 || p.Page != 2 || p.PageSize != 2 {
			t.Fatalf("page 2 window: %s", w.Body.String())
		}
	}
	for _, bad := range []string{
		"/api/pay/orders?uid=abc",
		"/api/pay/orders?uid=-1",
		"/api/pay/orders?createdFrom=not-a-date",
		"/api/pay/orders?createdTo=2026-13-40",
		"/api/pay/orders?page=0",
		"/api/pay/orders?pageSize=101",
	} {
		if w := env.do(t, http.MethodGet, bad, ""); w.Code != http.StatusBadRequest {
			t.Fatalf("%s must be 400, got %d body %s", bad, w.Code, w.Body.String())
		}
	}
}

func TestPayOrderDetailAndCallbacks(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	seedPayOrder(t, "PO-D", 2001, "PAID", "ALIPAY", 1800, time.Now())
	seedPayCallback(t, "PO-D", "VALID", "ACCEPTED")
	seedPayCallback(t, "PO-D", "INVALID", "IGNORED")
	trade := "TRADE-D"
	if err := db.PayDB.Model(&model.PayOrder{}).Where("order_no = ?", "PO-D").
		Update("channel_trade_no", trade).Error; err != nil {
		t.Fatalf("seed trade no: %v", err)
	}

	w := env.do(t, http.MethodGet, "/api/pay/orders/PO-D", "")
	if w.Code != http.StatusOK {
		t.Fatalf("order detail: got %d, body %s", w.Code, w.Body.String())
	}
	var detail struct {
		Order struct {
			OrderNo     string  `json:"orderNo"`
			UID         string  `json:"uid"`
			AmountCents int64   `json:"amountCents"`
			PaidAt      *string `json:"paidAt"`
			ClosedAt    *string `json:"closedAt"`
		} `json:"order"`
	}
	decodeJSON(t, w.Body.String(), &detail)
	if detail.Order.OrderNo != "PO-D" || detail.Order.UID != "2001" ||
		detail.Order.AmountCents != 1800 || detail.Order.PaidAt != nil || detail.Order.ClosedAt != nil {
		t.Fatalf("order detail body: %s", w.Body.String())
	}

	// tradeNo fallback when the order number is unknown.
	w = env.do(t, http.MethodGet, "/api/pay/orders/NOPE?tradeNo="+trade, "")
	if w.Code != http.StatusOK {
		t.Fatalf("trade no fallback: got %d, body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w.Body.String(), &detail)
	if detail.Order.OrderNo != "PO-D" {
		t.Fatalf("trade no fallback resolved wrong order: %s", w.Body.String())
	}

	// Unknown order -> 404 with the detail contract.
	w = env.do(t, http.MethodGet, "/api/pay/orders/PO-NOPE", "")
	if w.Code != http.StatusNotFound || w.Body.String() != `{"detail":"order not found"}` {
		t.Fatalf("unknown order: got %d %s", w.Code, w.Body.String())
	}

	// Callback ledger, newest first.
	w = env.do(t, http.MethodGet, "/api/pay/orders/PO-D/callbacks", "")
	if w.Code != http.StatusOK {
		t.Fatalf("callbacks: got %d, body %s", w.Code, w.Body.String())
	}
	var cbs struct {
		Items []struct {
			OrderNo         string  `json:"orderNo"`
			Channel         string  `json:"channel"`
			PayloadMasked   *string `json:"payloadMasked"`
			SignatureResult string  `json:"signatureResult"`
			HandleResult    string  `json:"handleResult"`
			Message         *string `json:"message"`
			CreatedAt       string  `json:"createdAt"`
		} `json:"items"`
		Total int64 `json:"total"`
	}
	decodeJSON(t, w.Body.String(), &cbs)
	if cbs.Total != 2 || len(cbs.Items) != 2 || cbs.Items[0].SignatureResult != "INVALID" ||
		cbs.Items[1].SignatureResult != "VALID" || cbs.Items[0].PayloadMasked == nil ||
		cbs.Items[0].CreatedAt == "" {
		t.Fatalf("callbacks body: %s", w.Body.String())
	}
}

// ── memberships / events / products ─────────────────────────────────────

func TestPayMembershipsEventsProducts(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	now := time.Now()
	lastOrder := "PO-X"
	seedPayMembership(t, 3001, "VIP", now.Add(10*24*time.Hour), &lastOrder)
	if err := db.PayDB.Create(&model.PayMembershipEvent{
		UID: 3001, Type: "ACTIVATE", Days: 30,
		ExpireBefore: now, ExpireAfter: now.Add(10 * 24 * time.Hour), CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed event: %v", err)
	}
	for i, p := range []model.PayProduct{
		{Code: "VIP_YEARLY", Title: "VIP 年卡", DurationDays: 365, PriceCents: 15800, Status: "ACTIVE", Sort: 2, CreatedAt: now, UpdatedAt: now},
		{Code: "VIP_MONTHLY", Title: "VIP 月卡", DurationDays: 30, PriceCents: 1800, Status: "ACTIVE", Sort: 0, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.PayDB.Create(&p).Error; err != nil {
			t.Fatalf("seed product %d: %v", i, err)
		}
	}

	// uid exact lookup -> {"membership": item}; active is lazy expiry.
	w := env.do(t, http.MethodGet, "/api/pay/memberships?uid=3001", "")
	if w.Code != http.StatusOK {
		t.Fatalf("membership lookup: got %d, body %s", w.Code, w.Body.String())
	}
	var lookup struct {
		Membership *struct {
			UID         string  `json:"uid"`
			Tier        string  `json:"tier"`
			Active      bool    `json:"active"`
			ExpireAt    string  `json:"expireAt"`
			AutoRenew   bool    `json:"autoRenew"`
			LastOrderNo *string `json:"lastOrderNo"`
			CreatedAt   string  `json:"createdAt"`
			UpdatedAt   string  `json:"updatedAt"`
		} `json:"membership"`
	}
	decodeJSON(t, w.Body.String(), &lookup)
	if lookup.Membership == nil || lookup.Membership.UID != "3001" || lookup.Membership.Tier != "VIP" ||
		!lookup.Membership.Active || lookup.Membership.LastOrderNo == nil || *lookup.Membership.LastOrderNo != "PO-X" {
		t.Fatalf("membership lookup body: %s", w.Body.String())
	}

	// Unknown uid -> {"membership": null}, never 404.
	w = env.do(t, http.MethodGet, "/api/pay/memberships?uid=9999", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"membership":null`) {
		t.Fatalf("unknown membership: got %d %s", w.Code, w.Body.String())
	}
	for _, bad := range []string{"/api/pay/memberships?uid=0", "/api/pay/memberships?uid=abc"} {
		if w := env.do(t, http.MethodGet, bad, ""); w.Code != http.StatusBadRequest {
			t.Fatalf("%s must be 400, got %d", bad, w.Code)
		}
	}

	// Full listing.
	w = env.do(t, http.MethodGet, "/api/pay/memberships", "")
	var memberPage struct {
		Items []struct {
			UID string `json:"uid"`
		} `json:"items"`
		Total int64 `json:"total"`
	}
	decodeJSON(t, w.Body.String(), &memberPage)
	if w.Code != http.StatusOK || memberPage.Total != 1 || len(memberPage.Items) != 1 || memberPage.Items[0].UID != "3001" {
		t.Fatalf("membership list: got %d %s", w.Code, w.Body.String())
	}

	// Per-member event stream.
	w = env.do(t, http.MethodGet, "/api/pay/memberships/3001/events", "")
	var evPage struct {
		Items []struct {
			ID           int64   `json:"id"`
			UID          string  `json:"uid"`
			Type         string  `json:"type"`
			OrderNo      *string `json:"orderNo"`
			Days         int     `json:"days"`
			ExpireBefore string  `json:"expireBefore"`
			ExpireAfter  string  `json:"expireAfter"`
			Reason       *string `json:"reason"`
			CreatedAt    string  `json:"createdAt"`
		} `json:"items"`
		Total int64 `json:"total"`
	}
	decodeJSON(t, w.Body.String(), &evPage)
	if w.Code != http.StatusOK || evPage.Total != 1 || evPage.Items[0].Type != "ACTIVATE" ||
		evPage.Items[0].UID != "3001" || evPage.Items[0].Days != 30 || evPage.Items[0].OrderNo != nil ||
		evPage.Items[0].Reason != nil || evPage.Items[0].CreatedAt == "" {
		t.Fatalf("member events: got %d %s", w.Code, w.Body.String())
	}

	// Global stream with type / uid filters.
	if w := env.do(t, http.MethodGet, "/api/pay/events?type=ADMIN_GRANT", ""); w.Code != http.StatusOK {
		t.Fatalf("global events: got %d", w.Code)
	} else {
		var p struct {
			Total int64 `json:"total"`
		}
		decodeJSON(t, w.Body.String(), &p)
		if p.Total != 0 {
			t.Fatalf("ADMIN_GRANT filter should be empty: %s", w.Body.String())
		}
	}
	if w := env.do(t, http.MethodGet, "/api/pay/events?uid=3001", ""); w.Code != http.StatusOK {
		t.Fatalf("global events uid filter: got %d", w.Code)
	}

	// SKU catalog ordered sort ASC, id ASC.
	w = env.do(t, http.MethodGet, "/api/pay/products", "")
	var products struct {
		Items []struct {
			Code         string `json:"code"`
			Title        string `json:"title"`
			DurationDays int    `json:"durationDays"`
			PriceCents   int64  `json:"priceCents"`
			Status       string `json:"status"`
			Sort         int    `json:"sort"`
			CreatedAt    string `json:"createdAt"`
			UpdatedAt    string `json:"updatedAt"`
		} `json:"items"`
	}
	decodeJSON(t, w.Body.String(), &products)
	if w.Code != http.StatusOK || len(products.Items) != 2 ||
		products.Items[0].Code != "VIP_MONTHLY" || products.Items[1].Code != "VIP_YEARLY" ||
		products.Items[0].PriceCents != 1800 {
		t.Fatalf("products: got %d %s", w.Code, w.Body.String())
	}
}

// ── compensation grant (fund write) ─────────────────────────────────────

func TestPayGrantCreatesMembershipAndAudits(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})

	w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":5001,"durationDays":30,"reason":"客诉补偿"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("grant: got %d, body %s", w.Code, w.Body.String())
	}
	var resp struct {
		UID          string `json:"uid"`
		Tier         string `json:"tier"`
		Days         int    `json:"days"`
		ExpireBefore string `json:"expireBefore"`
		ExpireAfter  string `json:"expireAfter"`
		Created      bool   `json:"created"`
		Active       bool   `json:"active"`
	}
	decodeJSON(t, w.Body.String(), &resp)
	if resp.UID != "5001" || resp.Tier != "VIP" || resp.Days != 30 || !resp.Created || !resp.Active ||
		resp.ExpireBefore == "" || resp.ExpireAfter == "" {
		t.Fatalf("grant response: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"uid":"5001"`) {
		t.Fatalf("grant response uid must be a string: %s", w.Body.String())
	}
	after, err := time.Parse(time.RFC3339, resp.ExpireAfter)
	if err != nil {
		t.Fatalf("expireAfter parse: %v", err)
	}
	want := time.Now().AddDate(0, 0, 30)
	if diff := after.Sub(want); diff > time.Minute || diff < -time.Minute {
		t.Fatalf("expireAfter = %s, want ~%s", after, want)
	}

	// DB effects: membership row + ADMIN_GRANT event with operator prefix.
	m, err := repo.GetMembershipByUID(5001)
	if err != nil || m == nil {
		t.Fatalf("membership after grant: %v %v", m, err)
	}
	if m.Tier != "VIP" {
		t.Fatalf("membership tier: %s", m.Tier)
	}
	evs, total, err := repo.ListEventsByUID(5001, 10, 0)
	if err != nil || total != 1 {
		t.Fatalf("events after grant: total=%d err=%v", total, err)
	}
	if evs[0].Type != "ADMIN_GRANT" || evs[0].Days != 30 || evs[0].Reason == nil ||
		*evs[0].Reason != "[admin] 客诉补偿" {
		t.Fatalf("grant event: %+v", evs[0])
	}

	// admin_audit row (main DB).
	var audits []model.AdminAudit
	if err := db.DB.Where("action = ?", "pay_grant").Find(&audits).Error; err != nil {
		t.Fatalf("query admin_audit: %v", err)
	}
	if len(audits) != 1 || audits[0].AdminName != "admin" || audits[0].TargetType == nil ||
		*audits[0].TargetType != "membership" || audits[0].TargetID == nil || *audits[0].TargetID != "5001" ||
		audits[0].Detail == nil || !strings.Contains(*audits[0].Detail, "days=30") ||
		!strings.Contains(*audits[0].Detail, "tier=VIP") || !strings.Contains(*audits[0].Detail, "客诉补偿") {
		t.Fatalf("admin_audit row: %+v", audits)
	}

	// JSONL fund trail: hash-chained MEMBERSHIP_EXTENDED line.
	raw, err := os.ReadFile(env.auditPath)
	if err != nil {
		t.Fatalf("read audit jsonl: %v", err)
	}
	text := string(raw)
	for _, want := range []string{
		`"event":"MEMBERSHIP_EXTENDED"`, `"operator":"admin"`, `"uid":"5001"`,
		`"days":30`, `"created":true`, `"source":"app-admin"`, `"chain":"ch-`, `"prev":"GENESIS"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("audit jsonl missing %s: %s", want, text)
		}
	}
}

func TestPayGrantAcceptsStringUID(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":"5002","durationDays":5,"reason":"字符串 uid"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("grant with string uid: got %d, body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"uid":"5002"`) {
		t.Fatalf("string uid response: %s", w.Body.String())
	}
}

func TestPayGrantExtendSemantics(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	now := time.Now()

	// Active member: extend from expire_at, preserve last_order_no.
	expire := now.Add(10 * 24 * time.Hour)
	lastOrder := "PO-KEEP"
	seedPayMembership(t, 5003, "VIP", expire, &lastOrder)
	if w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":5003,"durationDays":5,"reason":"延时"}`); w.Code != http.StatusOK {
		t.Fatalf("grant active member: got %d, body %s", w.Code, w.Body.String())
	}
	m, _ := repo.GetMembershipByUID(5003)
	if want := expire.AddDate(0, 0, 5); m.ExpireAt.Sub(want) > time.Minute || m.ExpireAt.Sub(want) < -time.Minute {
		t.Fatalf("active extend expire_at = %s, want ~%s", m.ExpireAt, want)
	}
	if m.LastOrderNo == nil || *m.LastOrderNo != "PO-KEEP" {
		t.Fatalf("last_order_no must be preserved, got %+v", m.LastOrderNo)
	}

	// Expired member: restart from now.
	seedPayMembership(t, 5004, "VIP", now.Add(-48*time.Hour), nil)
	if w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":5004,"durationDays":7,"reason":"恢复"}`); w.Code != http.StatusOK {
		t.Fatalf("grant expired member: got %d", w.Code)
	}
	m, _ = repo.GetMembershipByUID(5004)
	if want := time.Now().AddDate(0, 0, 7); m.ExpireAt.Sub(want) > time.Minute || m.ExpireAt.Sub(want) < -time.Minute {
		t.Fatalf("expired extend expire_at = %s, want ~%s", m.ExpireAt, want)
	}

	// Explicit tier upgrade on an existing membership.
	seedPayMembership(t, 5005, "VIP", now.Add(24*time.Hour), nil)
	w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":5005,"durationDays":30,"reason":"升档","tier":"SVIP"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("grant tier: got %d, body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"tier":"SVIP"`) {
		t.Fatalf("tier response: %s", w.Body.String())
	}
	if m, _ := repo.GetMembershipByUID(5005); m.Tier != "SVIP" {
		t.Fatalf("membership tier after SVIP grant: %s", m.Tier)
	}
}

func TestPayGrantValidation(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	cases := []struct {
		name string
		body string
	}{
		{"uid zero", `{"uid":0,"durationDays":30,"reason":"x"}`},
		{"uid negative", `{"uid":-5,"durationDays":30,"reason":"x"}`},
		{"uid float", `{"uid":1.5,"durationDays":30,"reason":"x"}`},
		{"uid missing", `{"durationDays":30,"reason":"x"}`},
		{"days zero", `{"uid":1,"durationDays":0,"reason":"x"}`},
		{"days too large", `{"uid":1,"durationDays":4000,"reason":"x"}`},
		{"empty reason", `{"uid":1,"durationDays":30,"reason":"   "}`},
		{"invalid tier", `{"uid":1,"durationDays":30,"reason":"x","tier":"GOLD"}`},
		{"reason overflow", fmt.Sprintf(`{"uid":1,"durationDays":30,"reason":%q}`, strings.Repeat("长", 200))},
		{"broken json", `{"uid":`},
	}
	for _, tc := range cases {
		if w := env.do(t, http.MethodPost, "/api/pay/grants", tc.body); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want 400 (body %s)", tc.name, w.Code, w.Body.String())
		}
	}
	// Nothing was written by rejected requests.
	if _, total, _ := repo.ListEvents(repo.EventFilter{}); total != 0 {
		t.Fatalf("rejected grants must not write events, got %d", total)
	}
}

func TestPayGrantViewerForbidden(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{})
	if w := env.do(t, http.MethodPost, "/api/console/users",
		`{"username":"pay-viewer","password":"viewer-pass-123","role":"viewer"}`); w.Code != http.StatusOK {
		t.Fatalf("seed viewer: got %d, body %s", w.Code, w.Body.String())
	}
	viewer := loginAs(t, env.engine, "pay-viewer", "viewer-pass-123")

	// Viewer CAN read the pay domain...
	if w := apiDo(env.engine, http.MethodGet, "/api/pay/orders", "", viewer); w.Code != http.StatusOK {
		t.Fatalf("viewer list orders: got %d", w.Code)
	}
	// ...but cannot grant.
	w := apiDo(env.engine, http.MethodPost, "/api/pay/grants",
		`{"uid":1,"durationDays":30,"reason":"x"}`, viewer)
	if w.Code != http.StatusForbidden {
		t.Fatalf("viewer grant: got %d, want 403 (body %s)", w.Code, w.Body.String())
	}
}

func TestPayGrantDailyQuota(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{grantCaps: service.GrantCaps{DailyMaxCount: 1}})
	if w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":6001,"durationDays":10,"reason":"first"}`); w.Code != http.StatusOK {
		t.Fatalf("first grant: got %d, body %s", w.Code, w.Body.String())
	}
	w := env.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":6002,"durationDays":10,"reason":"second"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("second grant must hit the daily cap: got %d, body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "日补偿开通次数已达上限") {
		t.Fatalf("quota detail: %s", w.Body.String())
	}
	// The rejection is itself audited in the fund trail.
	raw, err := os.ReadFile(env.auditPath)
	if err != nil {
		t.Fatalf("read audit jsonl: %v", err)
	}
	if !strings.Contains(string(raw), `"event":"GRANT_DAILY_COUNT_EXCEEDED"`) {
		t.Fatalf("quota breach must be audited: %s", raw)
	}
	// No membership/event written for the rejected grant.
	if m, _ := repo.GetMembershipByUID(6002); m != nil {
		t.Fatal("quota-rejected grant must not create a membership")
	}

	// Day cap variant.
	env2 := newPayTestEnv(t, payTestOptions{grantCaps: service.GrantCaps{DailyMaxDays: 10}})
	w = env2.do(t, http.MethodPost, "/api/pay/grants",
		`{"uid":6003,"durationDays":30,"reason":"too many days"}`)
	if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), "日补偿开通天数已达上限") {
		t.Fatalf("day cap: got %d %s", w.Code, w.Body.String())
	}
	if raw, err := os.ReadFile(env2.auditPath); err != nil ||
		!strings.Contains(string(raw), `"event":"GRANT_DAILY_DAYS_EXCEEDED"`) {
		t.Fatalf("day-cap breach must be audited: %v %s", err, raw)
	}
}

// ── refund review ───────────────────────────────────────────────────────

// refundUpstream is a fake app-pay internal API capturing every call.
type refundUpstream struct {
	mu     sync.Mutex
	calls  []recordedCall
	status int
	body   string
	server *httptest.Server
}

type recordedCall struct {
	Path   string
	APIKey string
	Body   map[string]any
}

func newRefundUpstream(t *testing.T, status int, body string) *refundUpstream {
	t.Helper()
	u := &refundUpstream{status: status, body: body}
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var parsed map[string]any
		_ = json.NewDecoder(r.Body).Decode(&parsed)
		u.mu.Lock()
		u.calls = append(u.calls, recordedCall{Path: r.URL.Path, APIKey: r.Header.Get("apikey"), Body: parsed})
		status, body := u.status, u.body
		u.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(u.server.Close)
	return u
}

func (u *refundUpstream) recorded() []recordedCall {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]recordedCall(nil), u.calls...)
}

func seedRefundApproval(t *testing.T, orderNo, status string) {
	t.Helper()
	if err := db.PayDB.Create(&model.PayRefundApproval{
		OrderNo: orderNo, Maker: "ops-a", MakerReason: "客诉补偿",
		Status: status, CreatedAt: time.Now(),
	}).Error; err != nil {
		t.Fatalf("seed approval: %v", err)
	}
}

func TestRefundReviewStealth404WhenNotConfigured(t *testing.T) {
	// ops key absent: the whole group is invisible (404) even for an admin.
	env := newPayTestEnv(t, payTestOptions{refundEnabled: true})
	w := env.do(t, http.MethodGet, "/api/pay/refunds", "")
	if w.Code != http.StatusNotFound || w.Body.String() != `{"detail":"refund review not configured"}` {
		t.Fatalf("unconfigured refunds: got %d %s", w.Code, w.Body.String())
	}
	if w := env.do(t, http.MethodPost, "/api/pay/refunds/PO1/approve", "{}"); w.Code != http.StatusNotFound {
		t.Fatalf("unconfigured approve must be 404, got %d", w.Code)
	}
	// Master switch off with a full key: still 404.
	up := newRefundUpstream(t, http.StatusOK, `{"ok":true}`)
	env2 := newPayTestEnv(t, payTestOptions{opsBaseURL: up.server.URL, opsKey: "ops-key", refundEnabled: false})
	if w := env2.do(t, http.MethodGet, "/api/pay/refunds", ""); w.Code != http.StatusNotFound {
		t.Fatalf("switch-off refunds must be 404, got %d", w.Code)
	}
}

func TestRefundReviewListAndDecisions(t *testing.T) {
	up := newRefundUpstream(t, http.StatusOK, `{"ok":true}`)
	env := newPayTestEnv(t, payTestOptions{opsBaseURL: up.server.URL, opsKey: "ops-key", refundEnabled: true})
	seedRefundApproval(t, "PO1", "PENDING")

	// List reads pay_refund_approval directly (no upstream call).
	w := env.do(t, http.MethodGet, "/api/pay/refunds", "")
	if w.Code != http.StatusOK {
		t.Fatalf("refund list: got %d, body %s", w.Code, w.Body.String())
	}
	var page struct {
		Items []struct {
			OrderNo     string  `json:"orderNo"`
			Maker       string  `json:"maker"`
			MakerReason string  `json:"makerReason"`
			Status      string  `json:"status"`
			CreatedAt   string  `json:"createdAt"`
			DecidedAt   *string `json:"decidedAt"`
			Checker     *string `json:"checker"`
			CheckReason *string `json:"checkReason"`
		} `json:"items"`
		Total    int64 `json:"total"`
		Page     int   `json:"page"`
		PageSize int   `json:"pageSize"`
	}
	decodeJSON(t, w.Body.String(), &page)
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].OrderNo != "PO1" ||
		page.Items[0].Maker != "ops-a" || page.Items[0].Status != "PENDING" ||
		page.Items[0].DecidedAt != nil || page.Items[0].Checker != nil || page.Items[0].CheckReason != nil ||
		page.Items[0].CreatedAt == "" {
		t.Fatalf("refund list body: %s", w.Body.String())
	}
	if len(up.recorded()) != 0 {
		t.Fatal("refund list must not call the upstream")
	}

	// status filters: ALL = no filter, unknown status rejected.
	if w := env.do(t, http.MethodGet, "/api/pay/refunds?status=ALL", ""); w.Code != http.StatusOK {
		t.Fatalf("status=ALL: got %d", w.Code)
	}
	if w := env.do(t, http.MethodGet, "/api/pay/refunds?status=", ""); w.Code != http.StatusOK {
		t.Fatalf("empty status must mean ALL: got %d", w.Code)
	}
	if w := env.do(t, http.MethodGet, "/api/pay/refunds?status=BOGUS", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("bogus status: got %d, want 400", w.Code)
	}

	// Approve: proxies to app-pay with confirm=true + the operator identity.
	w = env.do(t, http.MethodPost, "/api/pay/refunds/PO1/approve", `{"reason":"复核通过"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("approve: got %d, body %s", w.Code, w.Body.String())
	}
	var result struct {
		OK        bool   `json:"ok"`
		OrderNo   string `json:"orderNo"`
		Confirmed bool   `json:"confirmed"`
		Checker   string `json:"checker"`
	}
	decodeJSON(t, w.Body.String(), &result)
	if !result.OK || result.OrderNo != "PO1" || !result.Confirmed || result.Checker != "admin" {
		t.Fatalf("approve response: %s", w.Body.String())
	}
	calls := up.recorded()
	if len(calls) != 1 || calls[0].Path != "/internal/pay/orders/PO1/refund" {
		t.Fatalf("approve upstream call: %+v", calls)
	}
	if calls[0].APIKey != "ops-key" {
		t.Fatalf("ops key must ride on the upstream call, got %q", calls[0].APIKey)
	}
	if calls[0].Body["operator"] != "admin" || calls[0].Body["confirm"] != true || calls[0].Body["reason"] != "复核通过" {
		t.Fatalf("approve upstream body: %+v", calls[0].Body)
	}

	// Reject: same proxy path with the reject endpoint.
	w = env.do(t, http.MethodPost, "/api/pay/refunds/PO1/reject", "{}")
	if w.Code != http.StatusOK {
		t.Fatalf("reject: got %d, body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w.Body.String(), &result)
	if !result.OK || result.Confirmed || result.Checker != "admin" {
		t.Fatalf("reject response: %s", w.Body.String())
	}
	calls = up.recorded()
	if len(calls) != 2 || calls[1].Path != "/internal/pay/orders/PO1/refund/reject" ||
		calls[1].Body["operator"] != "admin" {
		t.Fatalf("reject upstream call: %+v", calls)
	}

	// Both decisions are in the app-admin ledger + the JSONL fund trail.
	var actions []string
	{
		var audits []model.AdminAudit
		if err := db.DB.Where("target_type = ?", "pay_refund").Find(&audits).Error; err != nil {
			t.Fatalf("query refund audits: %v", err)
		}
		for _, a := range audits {
			actions = append(actions, a.Action)
		}
	}
	if len(actions) != 2 || !contains(actions, "pay_refund_approve") || !contains(actions, "pay_refund_reject") {
		t.Fatalf("refund audit actions: %+v", actions)
	}
	raw, err := os.ReadFile(env.auditPath)
	if err != nil {
		t.Fatalf("read audit jsonl: %v", err)
	}
	if !strings.Contains(string(raw), `"event":"REFUND_CONFIRMED"`) ||
		!strings.Contains(string(raw), `"event":"REFUND_REJECTED"`) {
		t.Fatalf("refund JSONL events: %s", raw)
	}
}

func TestRefundReviewUpstreamFailureMaps502(t *testing.T) {
	up := newRefundUpstream(t, http.StatusInternalServerError, `{"detail":"渠道退款失败"}`)
	env := newPayTestEnv(t, payTestOptions{opsBaseURL: up.server.URL, opsKey: "ops-key", refundEnabled: true})
	w := env.do(t, http.MethodPost, "/api/pay/refunds/PO9/approve", "{}")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("upstream failure must map to 502, got %d body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "渠道退款失败") {
		t.Fatalf("upstream detail must be passed through: %s", w.Body.String())
	}
	// A failed decision must not write an audit row.
	var n int64
	if err := db.DB.Model(&model.AdminAudit{}).Where("target_type = ?", "pay_refund").Count(&n).Error; err != nil {
		t.Fatalf("count refund audits: %v", err)
	}
	if n != 0 {
		t.Fatalf("failed upstream call must not be audited, got %d rows", n)
	}
}

func TestRefundReviewRejectsViewer(t *testing.T) {
	up := newRefundUpstream(t, http.StatusOK, `{"ok":true}`)
	env := newPayTestEnv(t, payTestOptions{opsBaseURL: up.server.URL, opsKey: "ops-key", refundEnabled: true})
	if w := env.do(t, http.MethodPost, "/api/console/users",
		`{"username":"refund-viewer","password":"viewer-pass-123","role":"viewer"}`); w.Code != http.StatusOK {
		t.Fatalf("seed viewer: got %d", w.Code)
	}
	viewer := loginAs(t, env.engine, "refund-viewer", "viewer-pass-123")
	if w := apiDo(env.engine, http.MethodGet, "/api/pay/refunds", "", viewer); w.Code != http.StatusForbidden {
		t.Fatalf("viewer refund list: got %d, want 403", w.Code)
	}
	if w := apiDo(env.engine, http.MethodPost, "/api/pay/refunds/PO1/approve", "{}", viewer); w.Code != http.StatusForbidden {
		t.Fatalf("viewer approve: got %d, want 403", w.Code)
	}
	if len(up.recorded()) != 0 {
		t.Fatal("a rejected viewer must never reach the upstream")
	}
}

func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
