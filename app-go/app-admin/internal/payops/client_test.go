package payops

// Refund-review client tests: the two decision endpoints, the ops-key header,
// body shape and the {"detail"} error passthrough (mapped to 502 upstream).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type capturedCall struct {
	Path   string
	APIKey string
	Body   map[string]any
}

func TestClientEnabled(t *testing.T) {
	cases := []struct {
		base, key string
		want      bool
	}{
		{"http://apisix:9080", "k", true},
		{"", "k", false},
		{"http://apisix:9080", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		if got := New(tc.base, tc.key, 0).Enabled(); got != tc.want {
			t.Fatalf("New(%q,%q).Enabled() = %v, want %v", tc.base, tc.key, got, tc.want)
		}
	}
	if (*Client)(nil).Enabled() {
		t.Fatal("nil client must not be enabled")
	}
}

func TestClientConfirmAndReject(t *testing.T) {
	var mu sync.Mutex
	var calls []capturedCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		calls = append(calls, capturedCall{Path: r.URL.Path, APIKey: r.Header.Get("apikey"), Body: body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)

	client := New(srv.URL+"/", "ops-key", 5)
	ctx := context.Background()
	if err := client.ConfirmRefund(ctx, "PO1", "admin", "复核通过"); err != nil {
		t.Fatalf("confirm refund: %v", err)
	}
	if err := client.RejectRefund(ctx, "PO2", "admin"); err != nil {
		t.Fatalf("reject refund: %v", err)
	}
	if err := client.ConfirmRefundOrReject(ctx, "PO3", "admin", "why", true); err != nil {
		t.Fatalf("dispatch approve: %v", err)
	}
	if err := client.ConfirmRefundOrReject(ctx, "PO4", "admin", "why", false); err != nil {
		t.Fatalf("dispatch reject: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	wantPaths := []string{
		"/internal/pay/orders/PO1/refund",
		"/internal/pay/orders/PO2/refund/reject",
		"/internal/pay/orders/PO3/refund",
		"/internal/pay/orders/PO4/refund/reject",
	}
	if len(calls) != len(wantPaths) {
		t.Fatalf("expected %d calls, got %d: %+v", len(wantPaths), len(calls), calls)
	}
	for i, want := range wantPaths {
		if calls[i].Path != want {
			t.Fatalf("call %d path = %q, want %q", i, calls[i].Path, want)
		}
		if calls[i].APIKey != "ops-key" {
			t.Fatalf("call %d missing ops key: %q", i, calls[i].APIKey)
		}
		if calls[i].Body["operator"] != "admin" {
			t.Fatalf("call %d operator = %v", i, calls[i].Body["operator"])
		}
	}
	if calls[0].Body["confirm"] != true || calls[0].Body["reason"] != "复核通过" {
		t.Fatalf("approve body: %+v", calls[0].Body)
	}
	if _, ok := calls[1].Body["confirm"]; ok {
		t.Fatalf("reject body must not carry confirm: %+v", calls[1].Body)
	}
}

func TestClientErrorPassthrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"渠道退款失败"}`))
	}))
	t.Cleanup(srv.Close)

	err := New(srv.URL, "ops-key", 5).ConfirmRefund(context.Background(), "PO1", "admin", "")
	if err == nil {
		t.Fatal("upstream failure must return an error")
	}
	if !strings.Contains(err.Error(), "500") || !strings.Contains(err.Error(), "渠道退款失败") {
		t.Fatalf("error must carry status + app-pay detail: %v", err)
	}
}
