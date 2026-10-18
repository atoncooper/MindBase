package router

// Tests for the refund-review workbench : stealth 404 when the ops key is
// not configured, admin-only gating, and approve/reject proxying to the fake
// app-pay upstream (the money write happens in app-pay, not here).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"app-pay-admin/internal/appops"
	"app-pay-admin/internal/db"
	"app-pay-admin/internal/config"
	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"
	"app-pay-admin/internal/service"
)

// newRefundTestRouter builds a router with the workbench wired to a fake
// app-pay upstream and seeds one PENDING approval for order PO1.
func newRefundTestRouter(t *testing.T, configured bool, upstreamHits *atomic.Int32) (http.Handler, *httptest.Server) {
	t.Helper()
	setupTestDB(t)
	if err := repo.EnsureDefaultAdmin(); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	if err := db.DB.Create(&model.PayRefundApproval{
		OrderNo: "PO1", Maker: "ops-a", MakerReason: "客诉补偿",
		Status: "PENDING", CreatedAt: time.Now(),
	}).Error; err != nil {
		t.Fatalf("seed approval: %v", err)
	}

	// fake app-pay upstream: asserts the ops key rides on every call
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		if r.Header.Get("apikey") != "ops-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/internal/pay/refund-requests":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"order_no": "PO1", "maker": "ops-a", "maker_reason": "客诉补偿",
				"status": "PENDING", "created_at": "2026-10-18T00:00:00Z",
			}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		}
	}))
	t.Cleanup(fake.Close)

	cfg := &config.Config{}
	cfg.WebUI.Enabled = true
	cfg.AppPay.BaseURL = fake.URL
	cfg.AppPay.OpsKey = "ops-key"
	cfg.AppPay.RefundReviewEnabled = configured
	audit := service.NewAudit(filepath.Join(t.TempDir(), "a.jsonl"))
	t.Cleanup(func() { _ = audit.Close() })
	return New(cfg, service.NewGrantService(audit, service.GrantCaps{}),
		appops.New(cfg.AppPay.BaseURL, cfg.AppPay.OpsKey, 5)), fake
}

func TestRefundReviewStealthWhenNotConfigured(t *testing.T) {
	// ops key 空 = 整组 404（不可探测），即使 admin 已登录
	h, _ := newRefundTestRouter(t, false, &atomic.Int32{})
	w := doJSON(h, "GET", "/api/refunds", "", adminHeaders(t, h))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unconfigured refund list: got %d, want 404", w.Code)
	}
}

func TestRefundWorkbenchListAndApprove(t *testing.T) {
	var hits atomic.Int32
	h, _ := newRefundTestRouter(t, true, &hits)
	admin := adminHeaders(t, h)

	// list: reads the approval table
	w := doJSON(h, "GET", "/api/refunds", "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("list: got %d, body %s", w.Code, w.Body.String())
	}
	var out struct {
		Total int64 `json:"total"`
		Items []struct {
			OrderNo string `json:"order_no"`
			Status  string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse list: %v", err)
	}
	if out.Total != 1 || len(out.Items) != 1 || out.Items[0].OrderNo != "PO1" {
		t.Fatalf("list content: %+v", out)
	}

	// approve: proxies to app-pay with confirm=true and operator identity
	w = doJSON(h, "POST", "/api/refunds/PO1/approve", `{"reason":"复核通过"}`, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("approve: got %d, body %s", w.Code, w.Body.String())
	}
	if hits.Load() < 1 { // approve 必须打到 fake app-pay（list 走 DB，不经上游）
		t.Fatalf("upstream hits = %d, want >= 1 (approve POST)", hits.Load())
	}

	// reject: same proxy path
	w = doJSON(h, "POST", "/api/refunds/PO1/reject", "{}", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("reject: got %d, body %s", w.Code, w.Body.String())
	}
}

func TestRefundReviewRejectsViewerRole(t *testing.T) {
	// viewer 不能进复核工作台（admin-only）：approve 返回 403
	h, _ := newRefundTestRouter(t, true, &atomic.Int32{})
	// create a viewer account directly
	if _, err := repo.CreateUser("viewer1", "viewer-pass", repo.RoleViewer); err != nil {
		t.Fatalf("seed viewer: %v", err)
	}
	w := doJSON(h, "POST", "/api/login", `{"username":"viewer1","password":"viewer-pass"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("viewer login: %d", w.Code)
	}
	sid := sessionFromCookie(w)
	w = doJSON(h, "POST", "/api/refunds/PO1/approve", "{}", map[string]string{
		"Cookie": "payadmin_session=" + sid,
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("viewer approve: got %d, want 403", w.Code)
	}
}
