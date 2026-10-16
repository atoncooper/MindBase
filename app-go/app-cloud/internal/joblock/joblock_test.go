package joblock

import (
	"context"
	"testing"
	"time"
)

// Guard: the nil-client degradation path (Redis unavailable at boot in
// main.go) must return acquired=true with a safe idempotent release — the
// sweeper/reconciler predate the lease and must keep working unchanged in
// single-replica deployments.
func TestTryAcquireNilClientDegradesToUnlocked(t *testing.T) {
	release, ok := TryAcquire(context.Background(), nil, "trash-sweeper", time.Minute)
	if !ok {
		t.Fatal("nil client must degrade to acquired=true")
	}
	if release == nil {
		t.Fatal("release must be non-nil even for nil client")
	}
	release() // must not panic
	release() // and must be idempotent
}

// Tokens are the compare-and-delete guards: they must be unique (no two
// holders may ever share a token) and fixed-length hex.
func TestTokenUniqueAndHex(t *testing.T) {
	seen := make(map[string]bool, 256)
	for i := 0; i < 256; i++ {
		tok, err := newToken()
		if err != nil {
			t.Fatalf("newToken: %v", err)
		}
		if len(tok) != 32 {
			t.Fatalf("token length = %d, want 32", len(tok))
		}
		if seen[tok] {
			t.Fatalf("duplicate token %s after %d draws", tok, i)
		}
		seen[tok] = true
	}
}
