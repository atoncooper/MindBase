package router

// Tests for the pay-domain query endpoints and the membership grant write,
// against an in-memory SQLite mirroring the app_pay schema.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"
)

// seedOrder inserts one pay_order row with sensible defaults.
func seedOrder(t *testing.T, orderNo string, uid int64, status, channel string, cents int64, createdAt time.Time) {
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
	if err := db.DB.Create(o).Error; err != nil {
		t.Fatalf("seed order: %v", err)
	}
}

func seedCallback(t *testing.T, orderNo, sig, handle string) {
	t.Helper()
	payload := `{"masked":"..."}` // stored masked by app-pay already
	cb := &model.PayCallbackLog{
		OrderNo:         orderNo,
		Channel:         "ALIPAY",
		PayloadMasked:   &payload,
		SignatureResult: sig,
		HandleResult:    handle,
		CreatedAt:       time.Now(),
	}
	if err := db.DB.Create(cb).Error; err != nil {
		t.Fatalf("seed callback: %v", err)
	}
}

// ── orders ───────────────────────────────────────────────────────────

func TestOrdersListAndFilters(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)
	now := time.Now()
	seedOrder(t, "PO-A", 1001, "DELIVERED", "ALIPAY", 1800, now.Add(-3*time.Hour))
	seedOrder(t, "PO-B", 1001, "CLOSED", "MOCK", 4500, now.Add(-2*time.Hour))
	seedOrder(t, "PO-C", 1002, "CREATED", "ALIPAY", 15800, now.Add(-1*time.Hour))

	// Default listing: newest first, total reflects the filter.
	w := doJSON(h, "GET", "/api/orders", "", ah)
	if w.Code != http.StatusOK {
		t.Fatalf("list orders: got %d, body %s", w.Code, w.Body.String())
	}
	var resp struct {
		Total int `json:"total"`
		Items []struct {
			OrderNo string `json:"order_no"`
			Status  string `json:"status"`
			UID     int64  `json:"uid"`
		} `json:"items"`
	}
	mustParse(t, w.Body.String(), &resp)
	if resp.Total != 3 || len(resp.Items) != 3 || resp.Items[0].OrderNo != "PO-C" || resp.Items[2].OrderNo != "PO-A" {
		t.Fatalf("orders listing order/total: %s", w.Body.String())
	}

	// uid filter (idx_pay_order_uid_status).
	w = doJSON(h, "GET", "/api/orders?uid=1001", "", ah)
	mustParse(t, w.Body.String(), &resp)
	if resp.Total != 2 {
		t.Fatalf("uid filter total: %s", w.Body.String())
	}

	// status filter.
	w = doJSON(h, "GET", "/api/orders?status=CLOSED", "", ah)
	mustParse(t, w.Body.String(), &resp)
	if resp.Total != 1 || resp.Items[0].OrderNo != "PO-B" {
		t.Fatalf("status filter: %s", w.Body.String())
	}

	// Unique order_no lookup.
	w = doJSON(h, "GET", "/api/orders?order_no=PO-C", "", ah)
	mustParse(t, w.Body.String(), &resp)
	if resp.Total != 1 || resp.Items[0].UID != 1002 {
		t.Fatalf("order_no filter: %s", w.Body.String())
	}

	// Created_from excludes older rows (seeds: -3h/-2h/-1h; -150min keeps the
	// two newest). The +08:00 offset must be query-escaped ('+' decodes to a
	// space otherwise).
	w = doJSON(h, "GET", "/api/orders?created_from="+url.QueryEscape(now.Add(-150*time.Minute).Format(time.RFC3339)), "", ah)
	mustParse(t, w.Body.String(), &resp)
	if resp.Total != 2 {
		t.Fatalf("created_from filter: %s", w.Body.String())
	}

	// Pagination cap: limit beyond the max clamps to 200 (accepted), invalid
	// uid is rejected.
	if w := doJSON(h, "GET", "/api/orders?limit=500", "", ah); w.Code != http.StatusOK {
		t.Fatalf("limit>max: got %d, want 200 (clamped)", w.Code)
	}
	if w := doJSON(h, "GET", "/api/orders?uid=abc", "", ah); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid uid: got %d, want 400", w.Code)
	}
}

func TestOrderDetailAndCallbacks(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)
	seedOrder(t, "PO-D", 2001, "PAID", "ALIPAY", 1800, time.Now())
	seedCallback(t, "PO-D", "VALID", "ACCEPTED")
	seedCallback(t, "PO-D", "INVALID", "IGNORED")

	// Detail by order number.
	w := doJSON(h, "GET", "/api/orders/PO-D", "", ah)
	if w.Code != http.StatusOK {
		t.Fatalf("order detail: got %d", w.Code)
	}
	var detail struct {
		Order struct {
			OrderNo     string  `json:"order_no"`
			AmountCents int64   `json:"amount_cents"`
			PaidAt      *string `json:"paid_at"`
		} `json:"order"`
	}
	mustParse(t, w.Body.String(), &detail)
	if detail.Order.OrderNo != "PO-D" || detail.Order.AmountCents != 1800 || detail.Order.PaidAt != nil {
		t.Fatalf("order detail body: %s", w.Body.String())
	}

	// Callback ledger, newest first.
	w = doJSON(h, "GET", "/api/orders/PO-D/callbacks", "", ah)
	var cbs struct {
		Total int `json:"total"`
		Items []struct {
			SignatureResult string `json:"signature_result"`
			HandleResult    string `json:"handle_result"`
		} `json:"items"`
	}
	mustParse(t, w.Body.String(), &cbs)
	if cbs.Total != 2 || len(cbs.Items) != 2 {
		t.Fatalf("callbacks: %s", w.Body.String())
	}

	// Unknown order -> 404 (also without trade_no fallback).
	if w := doJSON(h, "GET", "/api/orders/PO-NOPE", "", ah); w.Code != http.StatusNotFound {
		t.Fatalf("unknown order: got %d, want 404", w.Code)
	}
}

// ── memberships + events ─────────────────────────────────────────────

func TestMembershipsAndEvents(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)
	now := time.Now()
	lastOrder := "PO-X"
	if err := db.DB.Create(&model.PayMembership{
		UID:         3001,
		Tier:        "VIP",
		ExpireAt:    now.Add(10 * 24 * time.Hour),
		LastOrderNo: &lastOrder,
		CreatedAt:   now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	if err := db.DB.Create(&model.PayMembershipEvent{
		UID: 3001, Type: "ACTIVATE", Days: 30,
		ExpireBefore: now, ExpireAfter: now.Add(10 * 24 * time.Hour),
		CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed event: %v", err)
	}

	// Exact lookup reports active=true for a future expire_at.
	w := doJSON(h, "GET", "/api/memberships?uid=3001", "", ah)
	var one struct {
		Membership *struct {
			UID    int64  `json:"uid"`
			Active bool   `json:"active"`
			Tier   string `json:"tier"`
		} `json:"membership"`
	}
	mustParse(t, w.Body.String(), &one)
	if one.Membership == nil || !one.Membership.Active || one.Membership.Tier != "VIP" {
		t.Fatalf("membership lookup: %s", w.Body.String())
	}

	// Unknown uid -> membership null (never an error).
	w = doJSON(h, "GET", "/api/memberships?uid=9999", "", ah)
	mustParse(t, w.Body.String(), &one)
	if one.Membership != nil {
		t.Fatalf("unknown membership should be null: %s", w.Body.String())
	}

	// Per-uid event stream.
	w = doJSON(h, "GET", "/api/memberships/3001/events", "", ah)
	var evs struct {
		Total int `json:"total"`
		Items []struct {
			Type string `json:"type"`
		} `json:"items"`
	}
	mustParse(t, w.Body.String(), &evs)
	if evs.Total != 1 || evs.Items[0].Type != "ACTIVATE" {
		t.Fatalf("member events: %s", w.Body.String())
	}

	// Global stream with type filter (feeds the ADMIN_GRANT audit review).
	w = doJSON(h, "GET", "/api/events?type=ADMIN_GRANT", "", ah)
	mustParse(t, w.Body.String(), &evs)
	if evs.Total != 0 {
		t.Fatalf("global events ADMIN_GRANT filter should be empty: %s", w.Body.String())
	}
}

func TestProductsList(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)
	now := time.Now()
	for i, p := range []model.PayProduct{
		{Code: "VIP_YEARLY", Title: "VIP 年卡", DurationDays: 365, PriceCents: 15800, Status: "ACTIVE", Sort: 2, CreatedAt: now, UpdatedAt: now},
		{Code: "VIP_MONTHLY", Title: "VIP 月卡", DurationDays: 30, PriceCents: 1800, Status: "ACTIVE", Sort: 0, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.DB.Create(&p).Error; err != nil {
			t.Fatalf("seed product %d: %v", i, err)
		}
	}
	w := doJSON(h, "GET", "/api/products", "", ah)
	var resp struct {
		Items []struct {
			Code       string `json:"code"`
			PriceCents int64  `json:"price_cents"`
		} `json:"items"`
	}
	mustParse(t, w.Body.String(), &resp)
	if len(resp.Items) != 2 || resp.Items[0].Code != "VIP_MONTHLY" {
		t.Fatalf("products sort: %s", w.Body.String())
	}
}

// ── grant (money-touching write, admin only) ─────────────────────────

func TestGrantCreatesMembership(t *testing.T) {
	h, auditPath := newTestRouterFull(t, "")
	ah := adminHeaders(t, h)

	w := doJSON(h, "POST", "/api/grants",
		`{"uid":5001,"duration_days":30,"reason":"客诉补偿"}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("grant: got %d, body %s", w.Code, w.Body.String())
	}
	var resp struct {
		UID      int64  `json:"uid"`
		Days     int    `json:"days"`
		ExpireAt string `json:"expire_after"`
		Created  bool   `json:"created"`
		Active   bool   `json:"active"`
	}
	mustParse(t, w.Body.String(), &resp)
	if resp.UID != 5001 || resp.Days != 30 || !resp.Created || !resp.Active {
		t.Fatalf("grant response: %s", w.Body.String())
	}

	// DB effects: new membership row + ADMIN_GRANT event with operator prefix.
	m, err := repo.GetMembershipByUID(5001)
	if err != nil || m == nil {
		t.Fatalf("membership after grant: %v %v", m, err)
	}
	want := time.Now().AddDate(0, 0, 30)
	if diff := m.ExpireAt.Sub(want); diff > time.Minute || diff < -time.Minute {
		t.Fatalf("expire_after = %s, want ~%s", m.ExpireAt, want)
	}
	evs, total, err := repo.ListEventsByUID(5001, 10, 0)
	if err != nil || total != 1 {
		t.Fatalf("events after grant: total=%d err=%v", total, err)
	}
	if evs[0].Type != "ADMIN_GRANT" || evs[0].Days != 30 || evs[0].Reason == nil ||
		*evs[0].Reason != "[admin] 客诉补偿" {
		t.Fatalf("grant event: %+v", evs[0])
	}

	// Audit JSONL got the money-touching line.
	b, err := os.ReadFile(auditPath)
	if err != nil || !strings.Contains(string(b), `"event":"MEMBERSHIP_EXTENDED"`) ||
		!strings.Contains(string(b), `"operator":"admin"`) {
		t.Fatalf("audit jsonl: err=%v body=%s", err, b)
	}
}

func TestGrantExtendsActiveMemberFromExpireAt(t *testing.T) {
	h, _ := newTestRouterFull(t, "")
	ah := adminHeaders(t, h)
	now := time.Now()
	expire := now.Add(10 * 24 * time.Hour)
	if err := db.DB.Create(&model.PayMembership{
		UID: 5002, Tier: "VIP", ExpireAt: expire, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed membership: %v", err)
	}

	w := doJSON(h, "POST", "/api/grants", `{"uid":5002,"duration_days":5,"reason":"延时"}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("grant active member: got %d, body %s", w.Code, w.Body.String())
	}
	m, _ := repo.GetMembershipByUID(5002)
	want := expire.AddDate(0, 0, 5) // 未到期：从 expire_at 顺延
	if diff := m.ExpireAt.Sub(want); diff > time.Minute || diff < -time.Minute {
		t.Fatalf("expire_after = %s, want ~%s", m.ExpireAt, want)
	}
}

func TestGrantExpiredMemberStartsFromNow(t *testing.T) {
	h, _ := newTestRouterFull(t, "")
	ah := adminHeaders(t, h)
	now := time.Now()
	if err := db.DB.Create(&model.PayMembership{
		UID: 5003, Tier: "VIP", ExpireAt: now.Add(-48 * time.Hour), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatalf("seed membership: %v", err)
	}

	w := doJSON(h, "POST", "/api/grants", `{"uid":5003,"duration_days":7,"reason":"恢复"}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("grant expired member: got %d", w.Code)
	}
	m, _ := repo.GetMembershipByUID(5003)
	want := time.Now().AddDate(0, 0, 7) // 已过期：从 now 起算
	if diff := m.ExpireAt.Sub(want); diff > time.Minute || diff < -time.Minute {
		t.Fatalf("expire_after = %s, want ~%s", m.ExpireAt, want)
	}
}

func TestGrantValidation(t *testing.T) {
	h, _ := newTestRouterFull(t, "")
	ah := adminHeaders(t, h)
	cases := []struct {
		name string
		body string
	}{
		{"uid zero", `{"uid":0,"duration_days":30,"reason":"x"}`},
		{"days zero", `{"uid":1,"duration_days":0,"reason":"x"}`},
		{"days too large", `{"uid":1,"duration_days":4000,"reason":"x"}`},
		{"empty reason", `{"uid":1,"duration_days":30,"reason":""}`},
		{"reason overflow", fmt.Sprintf(`{"uid":1,"duration_days":30,"reason":"%s"}`, strings.Repeat("长", 200))},
	}
	for _, tc := range cases {
		if w := doJSON(h, "POST", "/api/grants", tc.body, ah); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want 400 (body %s)", tc.name, w.Code, w.Body.String())
		}
	}
}

// ── users: last-admin + self-delete protection ──────────────────────

func TestUserManagementGuards(t *testing.T) {
	h := newTestRouter(t, "")
	ah := adminHeaders(t, h)

	// Create a second admin, then delete it (allowed: one admin remains).
	w := doJSON(h, "POST", "/api/users", `{"username":"boss","password":"boss-pass-123","role":"admin"}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("create admin: got %d, body %s", w.Code, w.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	mustParse(t, w.Body.String(), &created)

	// Duplicate username -> 409.
	if w := doJSON(h, "POST", "/api/users", `{"username":"boss","password":"boss-pass-123"}`, ah); w.Code != http.StatusConflict {
		t.Fatalf("duplicate username: got %d, want 409", w.Code)
	}

	// Cannot delete self (admin id 1).
	if w := doJSON(h, "DELETE", "/api/users/1", "", ah); w.Code != http.StatusBadRequest {
		t.Fatalf("delete self: got %d, want 400", w.Code)
	}

	// Delete the second admin, then deleting the last remaining admin is blocked.
	if w := doJSON(h, "DELETE", fmt.Sprintf("/api/users/%d", created.ID), "", ah); w.Code != http.StatusOK {
		t.Fatalf("delete second admin: got %d", w.Code)
	}
	if w := doJSON(h, "DELETE", "/api/users/1", "", ah); w.Code != http.StatusBadRequest {
		t.Fatalf("delete last admin: got %d, want 400", w.Code)
	}

	// Invalid role rejected.
	if w := doJSON(h, "POST", "/api/users", `{"username":"x1","password":"x1-pass-123","role":"superuser"}`, ah); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid role: got %d, want 400", w.Code)
	}
}

// ── shared helpers ───────────────────────────────────────────────────

func mustParse(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("parse %q: %v", body, err)
	}
}
