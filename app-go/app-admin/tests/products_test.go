package tests

// Black-box coverage for the authoritative SKU catalog CRUD (pay_product):
// list shape + tier, create/update/delete, authz (viewer 403 / admin allowed),
// validation, unique-code conflict, delete/disable safety and the audit trail
// (admin_audit + pay-audit JSONL).

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/repo"
)

func readAuditJSONL(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read pay audit jsonl: %v", err)
	}
	return string(raw)
}

func auditsFor(t *testing.T, action string) []model.AdminAudit {
	t.Helper()
	var rows []model.AdminAudit
	if err := db.DB.Where("action = ?", action).Find(&rows).Error; err != nil {
		t.Fatalf("query admin_audit action=%s: %v", action, err)
	}
	return rows
}

func countProducts(t *testing.T) int64 {
	t.Helper()
	var n int64
	if err := db.PayDB.Model(&model.PayProduct{}).Count(&n).Error; err != nil {
		t.Fatalf("count products: %v", err)
	}
	return n
}

// writeBody is the canonical valid create/update body.
func writeBody(code, title string, days int, priceCents int64, tier, status string, sort int) string {
	return fmt.Sprintf(
		`{"code":%q,"title":%q,"durationDays":%d,"priceCents":%d,"tier":%q,"status":%q,"sort":%d}`,
		code, title, days, priceCents, tier, status, sort)
}

func TestProductListShapeTierAndOrdering(t *testing.T) {
	env := newProductEnv(t)
	yearly := seedProduct(t, model.PayProduct{
		Code: "PROMAX_YEARLY", Title: "ProMax 年卡", DurationDays: 365,
		PriceCents: 217800, Tier: "PROMAX", Sort: 10,
	})
	monthly := seedProduct(t, model.PayProduct{
		Code: "VIP_MONTHLY", Title: "VIP 月卡", DurationDays: 30,
		PriceCents: 1800, Tier: "VIP", Sort: 20,
	})

	// viewer can read the catalog (read-only role).
	w := env.viewerDo(t, "GET", "/api/pay/products", "")
	if w.Code != 200 {
		t.Fatalf("viewer list products: got %d, body %s", w.Code, w.Body.String())
	}
	var body productListBody
	decodeJSON(t, w.Body.String(), &body)
	if len(body.Items) != 2 {
		t.Fatalf("expected 2 items, got %d: %s", len(body.Items), w.Body.String())
	}
	// sort ASC, id ASC.
	if body.Items[0].Code != "PROMAX_YEARLY" || body.Items[1].Code != "VIP_MONTHLY" {
		t.Fatalf("catalog ordering must be sort ASC: %s", w.Body.String())
	}
	first := body.Items[0]
	if first.ID != yearly.ID || first.Tier != "PROMAX" || first.Status != "ACTIVE" ||
		first.DurationDays != 365 || first.PriceCents != 217800 || first.Sort != 10 {
		t.Fatalf("product item shape: %+v", first)
	}
	if body.Items[1].ID != monthly.ID || body.Items[1].Tier != "VIP" {
		t.Fatalf("second product item shape: %+v", body.Items[1])
	}
	if first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Fatalf("timestamps must be rendered: %+v", first)
	}
}

func TestProductCreateAdminAndAudit(t *testing.T) {
	env := newProductEnv(t)
	body := writeBody("VIP_QUARTERLY", "VIP 季卡", 90, 12000, "VIP", "ACTIVE", 20)
	w := env.adminDo(t, "POST", "/api/pay/products", body)
	if w.Code != 200 {
		t.Fatalf("admin create: got %d, body %s", w.Code, w.Body.String())
	}
	var detail productDetailBody
	decodeJSON(t, w.Body.String(), &detail)
	if detail.Product.ID <= 0 || detail.Product.Code != "VIP_QUARTERLY" ||
		detail.Product.Title != "VIP 季卡" || detail.Product.DurationDays != 90 ||
		detail.Product.PriceCents != 12000 || detail.Product.Tier != "VIP" ||
		detail.Product.Status != "ACTIVE" || detail.Product.Sort != 20 {
		t.Fatalf("create response: %s", w.Body.String())
	}

	// DB row.
	row, err := repo.GetProductByCode("VIP_QUARTERLY")
	if err != nil || row == nil {
		t.Fatalf("product row after create: %v %v", row, err)
	}
	if row.Tier != "VIP" || row.ID != detail.Product.ID {
		t.Fatalf("stored row: %+v", row)
	}

	// admin_audit: operator + before/after summary.
	audits := auditsFor(t, "pay_product_create")
	if len(audits) != 1 {
		t.Fatalf("expected 1 pay_product_create audit, got %d", len(audits))
	}
	a := audits[0]
	if a.AdminName != "admin" || a.TargetType == nil || *a.TargetType != "pay_product" ||
		a.TargetID == nil || *a.TargetID != "VIP_QUARTERLY" || a.Detail == nil {
		t.Fatalf("create audit row: %+v", a)
	}
	if !strings.Contains(*a.Detail, "before=-") || !strings.Contains(*a.Detail, "after={code=VIP_QUARTERLY") ||
		!strings.Contains(*a.Detail, "priceCents=12000") || !strings.Contains(*a.Detail, "tier=VIP") {
		t.Fatalf("create audit detail must carry before/after: %s", *a.Detail)
	}

	// JSONL fund-adjacent trail.
	jsonl := readAuditJSONL(t, env.auditPath)
	for _, want := range []string{
		`"event":"PRODUCT_CREATED"`, `"operator":"admin"`,
		`"code":"VIP_QUARTERLY"`, `"price_cents":12000`,
		`"tier":"VIP"`, `"source":"app-admin"`,
	} {
		if !strings.Contains(jsonl, want) {
			t.Fatalf("pay-audit jsonl missing %s: %s", want, jsonl)
		}
	}

	// The list endpoint immediately reflects the write (optimistic refresh).
	w = env.adminDo(t, "GET", "/api/pay/products", "")
	if !strings.Contains(w.Body.String(), `"code":"VIP_QUARTERLY"`) {
		t.Fatalf("list must include the created product: %s", w.Body.String())
	}
}

func TestProductWritesAuthz(t *testing.T) {
	env := newProductEnv(t)
	seeded := seedProduct(t, model.PayProduct{Code: "VIP_MONTHLY"})

	// Anonymous is stopped by the session gate.
	if w := env.do(t, nil, "POST", "/api/pay/products",
		writeBody("X_SKU", "X", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 401 {
		t.Fatalf("anonymous create must be 401, got %d", w.Code)
	}
	// viewer: read yes, every write no.
	if w := env.viewerDo(t, "GET", "/api/pay/products", ""); w.Code != 200 {
		t.Fatalf("viewer read must be 200, got %d", w.Code)
	}
	if w := env.viewerDo(t, "POST", "/api/pay/products",
		writeBody("X_SKU", "X", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 403 {
		t.Fatalf("viewer create must be 403, got %d body %s", w.Code, w.Body.String())
	}
	if w := env.viewerDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", seeded.ID),
		writeBody("VIP_MONTHLY", "改名", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 403 {
		t.Fatalf("viewer update must be 403, got %d", w.Code)
	}
	if w := env.viewerDo(t, "DELETE", fmt.Sprintf("/api/pay/products/%d", seeded.ID), ""); w.Code != 403 {
		t.Fatalf("viewer delete must be 403, got %d", w.Code)
	}
	if n := countProducts(t); n != 1 {
		t.Fatalf("viewer writes must not change the catalog, rows=%d", n)
	}
	if len(auditsFor(t, "pay_product_create"))+len(auditsFor(t, "pay_product_update"))+
		len(auditsFor(t, "pay_product_delete"))+len(auditsFor(t, "pay_product_disable")) != 0 {
		t.Fatal("rejected viewer writes must not be audited as catalog writes")
	}

	// admin can create.
	if w := env.adminDo(t, "POST", "/api/pay/products",
		writeBody("X_SKU", "X 商品", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 200 {
		t.Fatalf("admin create must be 200, got %d body %s", w.Code, w.Body.String())
	}
}

func TestProductCreateValidation(t *testing.T) {
	env := newProductEnv(t)
	// A second ACTIVE SKU keeps the "last active" guard out of the picture.
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"})

	longCode := strings.Repeat("A", 51)
	longTitle := strings.Repeat("长", 101)
	cases := []struct {
		name string
		body string
	}{
		{"lowercase code", writeBody("vip_monthly", "VIP 月卡", 30, 1800, "VIP", "ACTIVE", 0)},
		{"empty code", writeBody("", "VIP 月卡", 30, 1800, "VIP", "ACTIVE", 0)},
		{"code too long", writeBody(longCode, "VIP 月卡", 30, 1800, "VIP", "ACTIVE", 0)},
		{"code with dash", writeBody("VIP-MONTHLY", "VIP 月卡", 30, 1800, "VIP", "ACTIVE", 0)},
		{"empty title", writeBody("VIP_MONTHLY", "   ", 30, 1800, "VIP", "ACTIVE", 0)},
		{"title too long", writeBody("VIP_MONTHLY", longTitle, 30, 1800, "VIP", "ACTIVE", 0)},
		{"days zero", writeBody("VIP_MONTHLY", "VIP 月卡", 0, 1800, "VIP", "ACTIVE", 0)},
		{"days too large", writeBody("VIP_MONTHLY", "VIP 月卡", 3651, 1800, "VIP", "ACTIVE", 0)},
		{"price zero", writeBody("VIP_MONTHLY", "VIP 月卡", 30, 0, "VIP", "ACTIVE", 0)},
		{"price negative", writeBody("VIP_MONTHLY", "VIP 月卡", 30, -100, "VIP", "ACTIVE", 0)},
		{"tier GOLD", writeBody("VIP_MONTHLY", "VIP 月卡", 30, 1800, "GOLD", "ACTIVE", 0)},
		{"tier empty", writeBody("VIP_MONTHLY", "VIP 月卡", 30, 1800, "", "ACTIVE", 0)},
		{"status ON_SALE", writeBody("VIP_MONTHLY", "VIP 月卡", 30, 1800, "VIP", "ON_SALE", 0)},
		{"sort negative", writeBody("VIP_MONTHLY", "VIP 月卡", 30, 1800, "VIP", "ACTIVE", -1)},
		{"broken json", `{"code":`},
	}
	before := countProducts(t)
	for _, tc := range cases {
		w := env.adminDo(t, "POST", "/api/pay/products", tc.body)
		if w.Code != 400 {
			t.Fatalf("%s: got %d, want 400 (body %s)", tc.name, w.Code, w.Body.String())
		}
	}
	if after := countProducts(t); after != before {
		t.Fatalf("rejected creates must not write rows: before=%d after=%d", before, after)
	}

	// Valid create still works after the rejections.
	if w := env.adminDo(t, "POST", "/api/pay/products",
		writeBody("VIP_MONTHLY", "VIP 月卡", 30, 1800, "VIP", "ACTIVE", 0)); w.Code != 200 {
		t.Fatalf("valid create after rejections: got %d body %s", w.Code, w.Body.String())
	}
}

func TestProductUpdateValidationAndNotFound(t *testing.T) {
	env := newProductEnv(t)
	seeded := seedProduct(t, model.PayProduct{Code: "VIP_MONTHLY"})
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"})
	path := fmt.Sprintf("/api/pay/products/%d", seeded.ID)

	// code is immutable.
	w := env.adminDo(t, "PUT", path, writeBody("VIP_OTHER", "改名", 30, 1800, "VIP", "ACTIVE", 0))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "不可修改") {
		t.Fatalf("code change must be 400 with 不可修改, got %d %s", w.Code, w.Body.String())
	}
	// field validation reuses the create rules.
	w = env.adminDo(t, "PUT", path, writeBody("VIP_MONTHLY", "改名", 30, 0, "VIP", "ACTIVE", 0))
	if w.Code != 400 {
		t.Fatalf("invalid price on update: got %d", w.Code)
	}
	// malformed id / unknown id.
	if w := env.adminDo(t, "PUT", "/api/pay/products/abc",
		writeBody("VIP_MONTHLY", "x", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 400 {
		t.Fatalf("malformed id must be 400, got %d", w.Code)
	}
	if w := env.adminDo(t, "PUT", "/api/pay/products/987654",
		writeBody("VIP_MONTHLY", "x", 30, 100, "VIP", "ACTIVE", 0)); w.Code != 404 {
		t.Fatalf("unknown product must be 404, got %d body %s", w.Code, w.Body.String())
	}
	if w := env.adminDo(t, "DELETE", "/api/pay/products/987654", ""); w.Code != 404 {
		t.Fatalf("delete unknown product must be 404, got %d", w.Code)
	}
	if w := env.adminDo(t, "DELETE", "/api/pay/products/abc", ""); w.Code != 400 {
		t.Fatalf("delete malformed id must be 400, got %d", w.Code)
	}
}

func TestProductUniqueCodeConflict(t *testing.T) {
	env := newProductEnv(t)
	seedProduct(t, model.PayProduct{Code: "VIP_MONTHLY"})
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"})

	w := env.adminDo(t, "POST", "/api/pay/products",
		writeBody("VIP_MONTHLY", "重复编码", 30, 1800, "VIP", "ACTIVE", 0))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "商品编码已存在") {
		t.Fatalf("duplicate code must be 409 with a Chinese message, got %d %s", w.Code, w.Body.String())
	}
	if n := countProducts(t); n != 2 {
		t.Fatalf("conflicting create must not insert, rows=%d", n)
	}
}

func TestProductUpdateFieldsAndAudit(t *testing.T) {
	env := newProductEnv(t)
	seeded := seedProduct(t, model.PayProduct{
		Code: "VIP_MONTHLY", Title: "VIP 月卡", DurationDays: 30,
		PriceCents: 1800, Tier: "VIP", Sort: 20,
	})
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"})

	body := writeBody("VIP_MONTHLY", "VIP 月卡（新）", 31, 1900, "VIP", "ACTIVE", 5)
	w := env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", seeded.ID), body)
	if w.Code != 200 {
		t.Fatalf("admin update: got %d, body %s", w.Code, w.Body.String())
	}
	var detail productDetailBody
	decodeJSON(t, w.Body.String(), &detail)
	if detail.Product.Title != "VIP 月卡（新）" || detail.Product.DurationDays != 31 ||
		detail.Product.PriceCents != 1900 || detail.Product.Sort != 5 || detail.Product.ID != seeded.ID {
		t.Fatalf("update response: %s", w.Body.String())
	}
	row, _ := repo.GetProductByID(seeded.ID)
	if row == nil || row.Title != "VIP 月卡（新）" || row.PriceCents != 1900 || row.Sort != 5 {
		t.Fatalf("stored row after update: %+v", row)
	}

	audits := auditsFor(t, "pay_product_update")
	if len(audits) != 1 || audits[0].TargetID == nil || *audits[0].TargetID != "VIP_MONTHLY" ||
		audits[0].Detail == nil {
		t.Fatalf("update audit row: %+v", audits)
	}
	// before/after summary carries both sides.
	if !strings.Contains(*audits[0].Detail, "before={code=VIP_MONTHLY") ||
		!strings.Contains(*audits[0].Detail, "priceCents=1800") ||
		!strings.Contains(*audits[0].Detail, "after={code=VIP_MONTHLY") ||
		!strings.Contains(*audits[0].Detail, "priceCents=1900") {
		t.Fatalf("update audit detail: %s", *audits[0].Detail)
	}
	jsonl := readAuditJSONL(t, env.auditPath)
	if !strings.Contains(jsonl, `"event":"PRODUCT_UPDATED"`) ||
		!strings.Contains(jsonl, `"price_cents":1900`) {
		t.Fatalf("PRODUCT_UPDATED jsonl: %s", jsonl)
	}

	// PUT is a full replacement but an omitted status keeps the stored one.
	disabled := seedProduct(t, model.PayProduct{
		Code: "OLD_SKU", Title: "旧商品", Status: "DISABLED",
	})
	keep := fmt.Sprintf(`{"code":"OLD_SKU","title":"旧商品改","durationDays":30,"priceCents":100,"tier":"VIP","sort":0}`)
	w = env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", disabled.ID), keep)
	if w.Code != 200 {
		t.Fatalf("update without status: got %d body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w.Body.String(), &detail)
	if detail.Product.Status != "DISABLED" || detail.Product.Title != "旧商品改" {
		t.Fatalf("omitted status must keep DISABLED: %s", w.Body.String())
	}

	// Disabling an ACTIVE SKU works while another ACTIVE SKU remains.
	w = env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", seeded.ID),
		writeBody("VIP_MONTHLY", "VIP 月卡（新）", 31, 1900, "VIP", "DISABLED", 5))
	if w.Code != 200 {
		t.Fatalf("disable with another active SKU: got %d body %s", w.Code, w.Body.String())
	}
	if row, _ := repo.GetProductByID(seeded.ID); row.Status != "DISABLED" {
		t.Fatalf("status after disable: %s", row.Status)
	}
}

func TestProductDeleteHardDeleteWhenUnreferenced(t *testing.T) {
	env := newProductEnv(t)
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"})
	gone := seedProduct(t, model.PayProduct{Code: "LEGACY_SKU", Status: "DISABLED"})

	w := env.adminDo(t, "DELETE", fmt.Sprintf("/api/pay/products/%d", gone.ID), "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"result":"deleted"`) {
		t.Fatalf("hard delete: got %d body %s", w.Code, w.Body.String())
	}
	if row, _ := repo.GetProductByID(gone.ID); row != nil {
		t.Fatalf("unreferenced SKU must be hard-deleted, still present: %+v", row)
	}
	audits := auditsFor(t, "pay_product_delete")
	if len(audits) != 1 || *audits[0].TargetID != "LEGACY_SKU" ||
		!strings.Contains(*audits[0].Detail, "after=-") {
		t.Fatalf("delete audit row: %+v", audits)
	}
	if jsonl := readAuditJSONL(t, env.auditPath); !strings.Contains(jsonl, `"event":"PRODUCT_DELETED"`) {
		t.Fatalf("PRODUCT_DELETED jsonl: %s", jsonl)
	}
}

func TestProductDeleteDisablesWhenReferencedByOrder(t *testing.T) {
	env := newProductEnv(t)
	seedProduct(t, model.PayProduct{Code: "VIP_YEARLY"}) // keeps one ACTIVE SKU
	referenced := seedProduct(t, model.PayProduct{Code: "VIP_MONTHLY"})
	seedOrder(t, "PO-HISTORY-1", "VIP_MONTHLY")

	w := env.adminDo(t, "DELETE", fmt.Sprintf("/api/pay/products/%d", referenced.ID), "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"result":"disabled"`) {
		t.Fatalf("referenced delete must degrade to disable: got %d body %s", w.Code, w.Body.String())
	}
	// Row kept, marked DISABLED; pay_order history untouched.
	row, _ := repo.GetProductByID(referenced.ID)
	if row == nil {
		t.Fatal("referenced SKU must not be hard-deleted")
	}
	if row.Status != "DISABLED" {
		t.Fatalf("referenced SKU must become DISABLED, got %s", row.Status)
	}
	var orders int64
	if err := db.PayDB.Model(&model.PayOrder{}).Where("sku_code = ?", "VIP_MONTHLY").Count(&orders).Error; err != nil || orders != 1 {
		t.Fatalf("order history must survive: n=%d err=%v", orders, err)
	}
	audits := auditsFor(t, "pay_product_disable")
	if len(audits) != 1 || audits[0].Detail == nil ||
		!strings.Contains(*audits[0].Detail, "reason") && !strings.Contains(*audits[0].Detail, "status=ACTIVE") {
		t.Fatalf("disable audit row: %+v", audits)
	}
	jsonl := readAuditJSONL(t, env.auditPath)
	if !strings.Contains(jsonl, `"event":"PRODUCT_DISABLED"`) ||
		!strings.Contains(jsonl, `"referenced_by_orders=1"`) {
		t.Fatalf("PRODUCT_DISABLED jsonl: %s", jsonl)
	}
}

func TestProductLastActiveGuard(t *testing.T) {
	env := newProductEnv(t)
	only := seedProduct(t, model.PayProduct{Code: "ONLY_SKU"})

	// Deleting the last ACTIVE SKU is refused (409, Chinese message).
	w := env.adminDo(t, "DELETE", fmt.Sprintf("/api/pay/products/%d", only.ID), "")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "最后一个在售商品") {
		t.Fatalf("last-active delete must be 409, got %d body %s", w.Code, w.Body.String())
	}
	// Disabling it through PUT is refused too.
	w = env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", only.ID),
		writeBody("ONLY_SKU", "唯一商品", 30, 1800, "VIP", "DISABLED", 0))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "最后一个在售商品") {
		t.Fatalf("last-active disable must be 409, got %d body %s", w.Code, w.Body.String())
	}
	if row, _ := repo.GetProductByID(only.ID); row == nil || row.Status != "ACTIVE" {
		t.Fatalf("guarded SKU must stay ACTIVE: %+v", row)
	}
	// Non-status edits of the same SKU still work.
	w = env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", only.ID),
		writeBody("ONLY_SKU", "唯一商品（改名）", 60, 2800, "SVIP", "ACTIVE", 3))
	if w.Code != 200 {
		t.Fatalf("non-status edit of last SKU: got %d body %s", w.Code, w.Body.String())
	}
	// After adding a second ACTIVE SKU the disable is allowed.
	seedProduct(t, model.PayProduct{Code: "SECOND_SKU"})
	w = env.adminDo(t, "PUT", fmt.Sprintf("/api/pay/products/%d", only.ID),
		writeBody("ONLY_SKU", "唯一商品（改名）", 60, 2800, "SVIP", "DISABLED", 3))
	if w.Code != 200 {
		t.Fatalf("disable after adding a second SKU: got %d body %s", w.Code, w.Body.String())
	}
}

func TestPayProductsGateWhenPaymentDisabled(t *testing.T) {
	env := newProductEnvOptions(t, true)

	// Session gate first: anonymous stays 401.
	if w := env.do(t, nil, "GET", "/api/pay/products", ""); w.Code != 401 {
		t.Fatalf("anonymous pay call must be 401, got %d", w.Code)
	}
	// Both reads and writes answer the 503 gate contract.
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/pay/products", ""},
		{"POST", "/api/pay/products", writeBody("X_SKU", "X", 30, 100, "VIP", "ACTIVE", 0)},
		{"PUT", "/api/pay/products/1", writeBody("X_SKU", "X", 30, 100, "VIP", "ACTIVE", 0)},
		{"DELETE", "/api/pay/products/1", ""},
	} {
		w := env.adminDo(t, tc.method, tc.path, tc.body)
		if w.Code != 503 || w.Body.String() != `{"detail":"支付管理未配置"}` {
			t.Fatalf("%s %s must answer the 503 gate, got %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}
