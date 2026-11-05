package tests

import (
	"testing"

	"app-cloud/internal/service"
)

// Claim priority: paid tiers drain before free. Free/empty tiers and inactive
// memberships map to the low-priority queue (fail-closed, consistent with the
// quota stance).
func TestTierStatusForTier(t *testing.T) {
	cases := []struct {
		tier   string
		active bool
		want   string
	}{
		{"svip", true, "pending"},
		{"SVIP", true, "pending"},
		{" vip ", true, "pending"},
		{"free", true, "pending_low"},
		{"", true, "pending_low"},
		{"vip", false, "pending_low"},
		{"svip", false, "pending_low"},
	}
	for _, c := range cases {
		if got := service.TierStatusForTier(c.tier, c.active); got != c.want {
			t.Fatalf("TierStatusForTier(%q, %v) = %q, want %q", c.tier, c.active, got, c.want)
		}
	}
}
