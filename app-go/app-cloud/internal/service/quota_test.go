package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"app-cloud/internal/config"
)

// newTestQuotaService builds a QuotaService against a fake app-pay endpoint
// (nil db/pending — TierFor touches neither).
func newTestQuotaService(t *testing.T, handler http.HandlerFunc) (*QuotaService, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	cfg := &config.Config{}
	cfg.Quota.MembershipBaseURL = srv.URL
	cfg.Quota.MembershipAPIKey = "k"
	cfg.Quota.MembershipCacheTTL = 60
	return NewQuotaService(cfg, nil, nil), &calls
}

func membershipBody(tier string, active bool) string {
	b, _ := json.Marshal(map[string]any{"uid": 42, "tier": tier, "active": active, "expireAt": "2027-01-01T00:00:00"})
	return string(b)
}

// TierFor must cache membership lookups: repeated calls within the TTL hit
// the in-process cache instead of the app-pay endpoint.
func TestTierForCachesMembership(t *testing.T) {
	q, calls := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(membershipBody("vip", true)))
	})
	for i := 0; i < 3; i++ {
		tier, err := q.TierFor(context.Background(), 42)
		if err != nil || tier != "vip" {
			t.Fatalf("call %d: tier=%q err=%v", i, tier, err)
		}
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected 1 upstream call for 3 lookups, got %d", got)
	}
}

// app-pay unreachable → fail-closed to the free tier (never block uploads on
// a pay-service outage), with the error surfaced to the caller.
func TestTierForFailClosedToFreeOnUpstreamError(t *testing.T) {
	q, _ := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	tier, err := q.TierFor(context.Background(), 42)
	if err == nil {
		t.Fatal("expected an error to be surfaced")
	}
	if tier != "free" {
		t.Fatalf("fail-closed tier = %q, want free", tier)
	}
}

// Tier normalization: SVIP/VIP case-insensitive, inactive membership reads
// as free.
func TestTierForNormalization(t *testing.T) {
	cases := []struct {
		tier   string
		active bool
		want   string
	}{
		{"svip", true, "svip"},
		{"SVIP", true, "svip"},
		{" vip ", true, "vip"},
		{"vip", false, "free"},
		{"", true, "free"},
	}
	for _, c := range cases {
		q, _ := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(membershipBody(c.tier, c.active)))
		})
		tier, err := q.TierFor(context.Background(), 42)
		if err != nil || tier != c.want {
			t.Fatalf("tier=%q active=%v: got %q (err %v), want %q", c.tier, c.active, tier, err, c.want)
		}
	}
}
