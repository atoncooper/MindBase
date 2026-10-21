package service

import (
	"testing"

	"app-cloud/internal/model"
	"time"

	"app-cloud/internal/config"
)

// seedTier pre-populates the quota tier cache so tierStatus can be tested
// without any HTTP or DB traffic.
func seedTier(q *QuotaService, uid int64, tier string, active bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.cache[uid] = quotaCacheEntry{tier: tier, active: active, expiresAt: time.Now().Add(time.Hour)}
}

// Claim priority: paid tiers drain before free. Unknown tier (quota cache
// miss / upstream failure) reads as free — fail-closed, consistent with the
// quota stance.
func TestTierStatusMapsMembershipTier(t *testing.T) {
	q := NewQuotaService(&config.Config{}, nil, nil)
	p := &Pipeline{quota: q}

	seedTier(q, 1, "svip", true)
	seedTier(q, 2, "vip", true)
	seedTier(q, 3, "free", true)
	seedTier(q, 4, "vip", false) // inactive membership reads as free

	cases := map[int64]string{1: "pending", 2: "pending", 3: "pending_low", 4: "pending_low"}
	for uid, want := range cases {
		if got := p.tierStatus(uid); got != want {
			t.Fatalf("uid %d: tierStatus = %q, want %q", uid, got, want)
		}
	}
}

// Without a quota service the legacy FIFO status is used (parity with the
// pre-priority behavior; queue-wide ordering degrades to id order).
func TestTierStatusWithoutQuotaService(t *testing.T) {
	p := &Pipeline{}
	if got := p.tierStatus(1); got != "pending" {
		t.Fatalf("nil quota: tierStatus = %q, want pending", got)
	}
}

// docDisplayTitle — user-set title wins over the original file name.
func modelFileForTest(title string) model.CloudFile {
	return model.CloudFile{Title: strPtr(title), OriginalName: "原名.xlsx"}
}

func strPtr(s string) *string { return &s }

func TestDocDisplayTitle(t *testing.T) {
	title := "用户标题"
	f1 := modelFileForTest(title)
	if got := docDisplayTitle(&f1); got != "用户标题" {
		t.Fatalf("got %q", got)
	}
	f2 := modelFileForTest("")
	if got := docDisplayTitle(&f2); got != "原名.xlsx" {
		t.Fatalf("empty title falls back to file name, got %q", got)
	}
}
