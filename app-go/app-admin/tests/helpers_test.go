// Package tests is the black-box test suite for the unified admin console,
// focused on the new authoritative SKU catalog CRUD (pay_product) added to the
// payment-operations plane. It is deliberately its own package (project
// convention: app-cloud / app-kg keep a tests/ package) and talks to the
// service only through its public HTTP surface.
//
// Harness mirrors internal/router/pay_test.go: TWO in-memory SQLite databases
// replace the two GORM handles (main admin_* tables + app_pay row mappings), so
// no real MySQL is needed and no heavy dependency is added.
package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"app-admin/internal/config"
	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/repo"
	"app-admin/internal/router"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupTestDBs swaps BOTH global GORM handles for fresh in-memory SQLite
// databases: admin_* own tables in the main DB, pay_* row mappings in the pay
// DB (production MySQL never migrates the latter, but the test schema mirrors
// the Java Flyway schema). Previous handles are restored on cleanup.
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

// loginAs logs in and returns the Cookie header for later requests.
func loginAs(t *testing.T, e http.Handler, username, password string) map[string]string {
	t.Helper()
	w := apiDo(e, http.MethodPost, "/api/login",
		fmt.Sprintf("{\"username\":%q,\"password\":%q}", username, password), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login %s: got %d, body %s", username, w.Code, w.Body.String())
	}
	const prefix = "admin_session="
	ck := w.Header().Get("Set-Cookie")
	i := strings.Index(ck, prefix)
	if i < 0 {
		t.Fatalf("login %s returned no session cookie", username)
	}
	rest := ck[i+len(prefix):]
	if j := strings.IndexByte(rest, ';'); j >= 0 {
		rest = rest[:j]
	}
	if rest == "" {
		t.Fatalf("login %s returned an empty session cookie", username)
	}
	return map[string]string{"Cookie": "admin_session=" + rest}
}

func decodeJSON(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("parse %q: %v", body, err)
	}
}

// productEnv is one fully wired console: SQLite databases, seeded admin+viewer,
// the payment plane enabled and a throwaway pay-audit JSONL sink.
type productEnv struct {
	engine    *gin.Engine
	admin     map[string]string
	viewer    map[string]string
	auditPath string
}

// newProductEnv builds the console with the payment module enabled.
func newProductEnv(t *testing.T) *productEnv {
	t.Helper()
	return newProductEnvOptions(t, false)
}

// newProductEnvOptions builds the console; payDisabled leaves the payment plane
// unwired so /api/pay/** must answer 503.
func newProductEnvOptions(t *testing.T, payDisabled bool) *productEnv {
	t.Helper()
	setupTestDBs(t)
	if err := repo.EnsureSeedAdmin("admin", "app-admin"); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	cfg := &config.Config{}
	cfg.Pay.AuditFile = filepath.Join(t.TempDir(), "pay-audit.jsonl")
	audit := service.NewPayAudit(cfg.Pay.AuditFile)
	t.Cleanup(func() { _ = audit.Close() })

	deps := router.Deps{
		Auth:    service.NewAuthService(0),
		Console: service.NewConsoleUserService(),
	}
	if !payDisabled {
		cfg.PayRDBMS.URL = "mysql+aiomysql://u:p@pay-mysql:3306/app_pay"
		deps.Pay = service.NewPayQueryService()
		deps.PayProducts = service.NewPayProductService(audit)
		deps.PayAudit = audit
	}
	e := router.New(cfg, deps)
	env := &productEnv{
		engine:    e,
		admin:     loginAs(t, e, "admin", "app-admin"),
		auditPath: cfg.Pay.AuditFile,
	}
	// One viewer account for the authorization tests.
	w := apiDo(e, http.MethodPost, "/api/console/users",
		`{"username":"viewer","password":"viewer-pass-123","role":"viewer"}`, env.admin)
	if w.Code != http.StatusOK {
		t.Fatalf("seed viewer: got %d, body %s", w.Code, w.Body.String())
	}
	env.viewer = loginAs(t, e, "viewer", "viewer-pass-123")
	return env
}

func (env *productEnv) do(t *testing.T, headers map[string]string, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return apiDo(env.engine, method, path, body, headers)
}

// adminDo / viewerDo are the two role variants used throughout the suite.
func (env *productEnv) adminDo(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return env.do(t, env.admin, method, path, body)
}

func (env *productEnv) viewerDo(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return env.do(t, env.viewer, method, path, body)
}

// seedProduct inserts one catalog row with sane timestamps; zero tier/status
// default to the app-pay canonical values.
func seedProduct(t *testing.T, p model.PayProduct) *model.PayProduct {
	t.Helper()
	now := time.Now()
	if p.Tier == "" {
		p.Tier = "VIP"
	}
	if p.Status == "" {
		p.Status = "ACTIVE"
	}
	if p.Code == "" {
		t.Fatal("seedProduct: code is required")
	}
	if p.Title == "" {
		p.Title = "测试商品 " + p.Code
	}
	if p.DurationDays == 0 {
		p.DurationDays = 30
	}
	if p.PriceCents == 0 {
		p.PriceCents = 1800
	}
	p.CreatedAt, p.UpdatedAt = now, now
	if err := db.PayDB.Create(&p).Error; err != nil {
		t.Fatalf("seed product %s: %v", p.Code, err)
	}
	return &p
}

// seedOrder inserts one pay_order snapshot referencing skuCode (delete-safety).
func seedOrder(t *testing.T, orderNo, skuCode string) {
	t.Helper()
	now := time.Now()
	o := &model.PayOrder{
		OrderNo:      orderNo,
		UID:          1001,
		SkuCode:      skuCode,
		ProductTitle: "历史快照",
		DurationDays: 30,
		AmountCents:  1800,
		Channel:      "MOCK",
		Status:       "DELIVERED",
		Version:      1,
		ExpiresAt:    now.Add(30 * time.Minute),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := db.PayDB.Create(o).Error; err != nil {
		t.Fatalf("seed order %s: %v", orderNo, err)
	}
}

// productListBody is the GET /api/pay/products envelope.
type productListBody struct {
	Items []struct {
		ID           int64  `json:"id"`
		Code         string `json:"code"`
		Title        string `json:"title"`
		DurationDays int    `json:"durationDays"`
		PriceCents   int64  `json:"priceCents"`
		Tier         string `json:"tier"`
		Status       string `json:"status"`
		Sort         int    `json:"sort"`
		CreatedAt    string `json:"createdAt"`
		UpdatedAt    string `json:"updatedAt"`
	} `json:"items"`
}

// productDetailBody is the POST/PUT success body.
type productDetailBody struct {
	Product struct {
		ID           int64  `json:"id"`
		Code         string `json:"code"`
		Title        string `json:"title"`
		DurationDays int    `json:"durationDays"`
		PriceCents   int64  `json:"priceCents"`
		Tier         string `json:"tier"`
		Status       string `json:"status"`
		Sort         int    `json:"sort"`
		CreatedAt    string `json:"createdAt"`
		UpdatedAt    string `json:"updatedAt"`
	} `json:"product"`
}
