package tests

import (
	"context"
	"testing"

	"app-user/internal/config"
	authservice "app-user/internal/service/auth"
)

// TestStrictRateLimitUsesLocalFallbackWhenRedisIsDown pins the security path:
// forward-auth must not lose its token/uid budget just because Redis is down.
func TestStrictRateLimitUsesLocalFallbackWhenRedisIsDown(t *testing.T) {
	r := authservice.NewRateLimits(nil, map[string]config.RateLimitRule{
		"verify_token": {Max: 3, Window: 60},
	})
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if ok, _ := r.AllowStrict(ctx, "verify_token", "hash"); !ok {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}
	if ok, retry := r.AllowStrict(ctx, "verify_token", "hash"); ok || retry < 1 {
		t.Fatalf("4th request must be blocked locally, got ok=%v retry=%d", ok, retry)
	}
	if ok, _ := r.AllowStrict(ctx, "verify_token", "other"); !ok {
		t.Fatal("a different dimension has its own local window")
	}
}
