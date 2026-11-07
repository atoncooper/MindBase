package tests

import (
	"context"
	"testing"
	"time"

	"app-user/internal/infra/cache"
	authservice "app-user/internal/service/auth"
)

// TestAuthzCacheL1 pins the hot-path behavior: roles/status are cached
// in-process (no Redis needed) and deletions take effect immediately.
func TestAuthzCacheL1(t *testing.T) {
	c := cache.NewAuthz(nil, "appauth:token:", time.Minute)

	if _, ok := c.GetRoles(context.Background(), 42); ok {
		t.Fatal("fresh cache must miss")
	}
	c.SetRoles(context.Background(), 42, []string{"free", "admin"})
	roles, ok := c.GetRoles(context.Background(), 42)
	if !ok || len(roles) != 2 || roles[0] != "free" || roles[1] != "admin" {
		t.Fatalf("roles = %v ok=%v", roles, ok)
	}
	c.DeleteRoles(context.Background(), 42)
	if _, ok := c.GetRoles(context.Background(), 42); ok {
		t.Fatal("deleted roles must miss")
	}

	if _, _, ok := c.GetStatus(context.Background(), 42); ok {
		t.Fatal("fresh status cache must miss")
	}
	c.SetStatus(context.Background(), 42, "banned", false)
	status, deleted, ok := c.GetStatus(context.Background(), 42)
	if !ok || status != "banned" || deleted {
		t.Fatalf("status = %q deleted=%v ok=%v", status, deleted, ok)
	}
	c.DeleteStatus(context.Background(), 42)
	if _, _, ok := c.GetStatus(context.Background(), 42); ok {
		t.Fatal("deleted status must miss")
	}
}

// TestSessionIDIsStableOpaqueID pins the session-management contract: the UI
// receives a 16-char non-credential id, never the bearer token itself.
func TestSessionIDIsStableOpaqueID(t *testing.T) {
	id := authservice.SessionID("session-token-value")
	if len(id) != 16 {
		t.Fatalf("session id length = %d, want 16", len(id))
	}
	if id == "session-token-value" || id == "" {
		t.Fatal("session id must be an opaque hash")
	}
	if again := authservice.SessionID("session-token-value"); again != id {
		t.Fatalf("session id not deterministic: %q vs %q", id, again)
	}
	if other := authservice.SessionID("another-token"); other == id {
		t.Fatal("different tokens must produce different ids")
	}
}

// TestTokenCacheTombstones pins the anti-resurrection contract: a revoked
// token must stay invalid even if a stale Validate tries to re-cache it, and
// random invalid tokens are negatively cached instead of hitting MySQL every
// time.
func TestTokenCacheTombstones(t *testing.T) {
	c := cache.New(nil, "test:token:", time.Minute)
	ctx := context.Background()

	c.SetTokenUID(ctx, "tok-1", 7)
	if got := c.GetTokenUID(ctx, "tok-1"); got != 7 {
		t.Fatalf("cached uid = %d, want 7", got)
	}
	c.DeleteToken(ctx, "tok-1")
	if !c.IsBlocked("tok-1") {
		t.Fatal("revoked token must be tombstoned")
	}
	if got := c.GetTokenUID(ctx, "tok-1"); got != 0 {
		t.Fatalf("revoked token returned uid %d", got)
	}
	// Simulate a concurrent Validate re-adding the pre-revoke mapping.
	c.SetTokenUID(ctx, "tok-1", 7)
	if got := c.GetTokenUID(ctx, "tok-1"); got != 0 {
		t.Fatalf("tombstone must prevent re-caching, got uid %d", got)
	}

	c.MarkInvalid("garbage")
	if !c.IsBlocked("garbage") {
		t.Fatal("invalid token must be negatively cached")
	}
	if got := c.GetTokenUID(ctx, "garbage"); got != 0 {
		t.Fatalf("invalid token returned uid %d", got)
	}
}
