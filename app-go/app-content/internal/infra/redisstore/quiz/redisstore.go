// Package redisstore — quiz share L2 cache + daily quota counters on the
// process-wide Redis client.
//
// The Python backend caches the public shared-quiz payload under
// mind-base:quiz_share:{token} (60s TTL) and app-quiz reads/writes/evicts the
// SAME keys, so both stacks stay coherent during and after the cutover.
// Every operation is fail-open: when Redis is unavailable the callers fall
// through to MySQL + MongoDB and the endpoint still works.
package redisstore

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store wraps the shared go-redis client with the shared key prefix.
// Nil client = disabled (fail-open).
type Store struct {
	client *redis.Client
	prefix string
}

// New wraps an already-connected client. Nil client disables the store.
func New(client *redis.Client, prefix string) *Store {
	if strings.TrimSpace(prefix) == "" {
		prefix = "mind-base:"
	}
	return &Store{client: client, prefix: prefix}
}

// Enabled reports whether a Redis connection is configured.
func (s *Store) Enabled() bool {
	return s != nil && s.client != nil
}

func (s *Store) key(parts ...string) string {
	return s.prefix + strings.Join(parts, ":")
}

// ShareCacheKey builds the canonical share-cache key for a token (exported
// so callers can log/evict without touching the prefix convention).
func (s *Store) ShareCacheKey(shareToken string) string {
	return s.key("quiz_share", shareToken)
}

// GetShareCached returns the cached shared-quiz payload for a token, or nil
// on miss / when disabled / on any error (fail-open).
func (s *Store) GetShareCached(ctx context.Context, shareToken string) (json.RawMessage, bool) {
	if !s.Enabled() {
		return nil, false
	}
	raw, err := s.client.Get(ctx, s.ShareCacheKey(shareToken)).Bytes()
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	return json.RawMessage(raw), true
}

// SetShareCached stores the payload with the 60s TTL (fail-open).
func (s *Store) SetShareCached(ctx context.Context, shareToken string, payload json.RawMessage) {
	if !s.Enabled() {
		return
	}
	_ = s.client.Set(ctx, s.ShareCacheKey(shareToken), payload, 60*time.Second).Err()
}

// EvictShare deletes the cache entry for a token (fail-open; no-op when
// token is empty). Used on create (old token) and revoke (revoked token) so
// stale links stop serving immediately at the L2 layer.
func (s *Store) EvictShare(ctx context.Context, shareToken string) {
	if !s.Enabled() || shareToken == "" {
		return
	}
	_ = s.client.Del(ctx, s.ShareCacheKey(shareToken)).Err()
}
