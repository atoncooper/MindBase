// Package cache provides the hot-path token→uid cache: L1 in-process memory
// plus optional L2 Redis (enabled when the shared client is non-nil).
//
// Reliability notes:
//   - Revocations write a short-lived tombstone (L1 + Redis) so a concurrent
//     Validate that read the pre-revoke DB row cannot resurrect the token.
//   - Invalid tokens are negatively cached in L1 for a few seconds, so random
//     token spam cannot turn every forward-auth request into a MySQL lookup.
//   - TTLs are jittered (±10%) to avoid synchronized expiry/DB stampedes.
//   - L1 is hard-capped: over-cap eviction is expired-first, then arbitrary
//     entries, and never a full sort under the write lock.
package cache

import (
	"context"
	"log/slog"
	"math/rand"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	l1MaxEntries = 100_000
	invalidTTL   = 30 * time.Second
)

type Cache struct {
	ns      string
	ttl     time.Duration
	mu      sync.RWMutex
	items   map[string]cacheEntry
	blocked map[string]time.Time // tombstones: revoked or known-invalid tokens
	rdb     redis.UniversalClient
	redisOK bool
}

type cacheEntry struct {
	uid     int64
	expires time.Time
}

// New builds a cache on top of the shared Redis client (nil = memory only,
// same degradation as the Python backend's optional L2).
func New(rdb redis.UniversalClient, namespace string, ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return &Cache{
		ns:      namespace,
		ttl:     ttl,
		items:   make(map[string]cacheEntry),
		blocked: make(map[string]time.Time),
		rdb:     rdb,
		redisOK: rdb != nil,
	}
}

func (c *Cache) key(token string) string        { return c.ns + token }
func (c *Cache) revokedKey(token string) string { return c.ns + "revoked:" + token }

func (c *Cache) jitter() time.Duration {
	// ±10%: spread expiry of tokens issued in the same login wave.
	return time.Duration(float64(c.ttl) * (0.9 + rand.Float64()*0.2))
}

// tombstoneTTL always outlives the longest positive TTL (ttl + 10% jitter).
func (c *Cache) tombstoneTTL() time.Duration {
	return c.ttl + c.ttl/10 + time.Minute
}

// GetTokenUID returns the cached uid for a token, or 0 on miss/revoked.
func (c *Cache) GetTokenUID(ctx context.Context, token string) int64 {
	if c == nil || token == "" {
		return 0
	}
	now := time.Now()
	c.mu.RLock()
	if exp, ok := c.blocked[token]; ok && now.Before(exp) {
		c.mu.RUnlock()
		return 0
	}
	if e, ok := c.items[token]; ok && now.Before(e.expires) {
		c.mu.RUnlock()
		return e.uid
	}
	c.mu.RUnlock()

	if !c.redisOK {
		return 0
	}
	// L1 miss: a revocation tombstone from another instance (or from before
	// this process restarted) must win over the positive entry.
	if n, err := c.rdb.Exists(ctx, c.revokedKey(token)).Result(); err == nil && n > 0 {
		c.blockLocally(token, c.tombstoneTTL())
		return 0
	}
	v, err := c.rdb.Get(ctx, c.key(token)).Result()
	if err != nil {
		return 0
	}
	uid, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0
	}
	c.mu.Lock()
	c.items[token] = cacheEntry{uid: uid, expires: now.Add(c.jitter())}
	c.pruneLocked(now)
	c.mu.Unlock()
	return uid
}

// SetTokenUID caches a token→uid mapping in L1 (+L2 when available). A token
// with a live tombstone is never re-cached (revocation wins over cache-aside
// read races).
func (c *Cache) SetTokenUID(ctx context.Context, token string, uid int64) {
	if c == nil || token == "" {
		return
	}
	now := time.Now()
	if c.redisOK {
		// Check the shared tombstone BEFORE writing L1: otherwise a token
		// revoked by another instance could be cached locally again.
		if n, err := c.rdb.Exists(ctx, c.revokedKey(token)).Result(); err == nil && n > 0 {
			c.blockLocally(token, c.tombstoneTTL())
			return
		}
	}
	c.mu.Lock()
	if exp, ok := c.blocked[token]; ok && now.Before(exp) {
		c.mu.Unlock()
		return
	}
	c.items[token] = cacheEntry{uid: uid, expires: now.Add(c.jitter())}
	c.pruneLocked(now)
	c.mu.Unlock()

	if c.redisOK {
		if err := c.rdb.Set(ctx, c.key(token), uid, c.jitter()).Err(); err != nil {
			slog.Warn("[CACHE] redis set failed", "err", err)
		}
	}
}

// DeleteToken is the revoke path: write a tombstone (L1 + Redis) before
// deleting the positive entry. If the Redis tombstone write fails, the local
// tombstone still prevents same-process resurrection; the failure is logged.
func (c *Cache) DeleteToken(ctx context.Context, token string) {
	if c == nil || token == "" {
		return
	}
	// Tombstone outlives the longest positive TTL (ttl + 10% jitter): if the
	// Redis DEL below ever fails, the positive key must still expire first.
	tombTTL := c.tombstoneTTL()
	c.blockLocally(token, tombTTL)
	c.mu.Lock()
	delete(c.items, token)
	c.mu.Unlock()
	if c.redisOK {
		if err := c.rdb.Set(ctx, c.revokedKey(token), "1", tombTTL).Err(); err != nil {
			slog.Warn("[CACHE] redis tombstone set failed", "err", err)
		}
		_ = c.rdb.Del(ctx, c.key(token)).Err()
		// Second tombstone write closes the "DEL after concurrent SET" window.
		_ = c.rdb.Set(ctx, c.revokedKey(token), "1", tombTTL).Err()
	}
}

// MarkInvalid negatively caches a token that failed DB validation. L1 only:
// creating Redis keys for arbitrary attacker-supplied tokens would be a
// memory-amplification vector. TTL is short so a token created right after
// cannot be shadowed for long (new tokens are random and never reused).
func (c *Cache) MarkInvalid(token string) {
	if c == nil || token == "" {
		return
	}
	c.blockLocally(token, invalidTTL)
}

// IsBlocked reports whether token has a live local tombstone. It is the
// fast path used before the positive cache lookup.
func (c *Cache) IsBlocked(token string) bool {
	if c == nil || token == "" {
		return false
	}
	now := time.Now()
	c.mu.RLock()
	exp, ok := c.blocked[token]
	c.mu.RUnlock()
	if !ok {
		return false
	}
	if now.Before(exp) {
		return true
	}
	c.mu.Lock()
	if e, exists := c.blocked[token]; exists && !now.Before(e) {
		delete(c.blocked, token)
	}
	c.mu.Unlock()
	return false
}

func (c *Cache) blockLocally(token string, d time.Duration) {
	if c == nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	if len(c.blocked) > l1MaxEntries {
		for k, exp := range c.blocked {
			if !now.Before(exp) {
				delete(c.blocked, k)
			}
		}
		if len(c.blocked) > l1MaxEntries {
			for k := range c.blocked {
				delete(c.blocked, k)
				if len(c.blocked) <= l1MaxEntries {
					break
				}
			}
		}
	}
	c.blocked[token] = now.Add(d)
	c.mu.Unlock()
}

// pruneLocked bounds L1 memory. Expired entries are removed first; if the map
// is still over the cap (all entries fresh), arbitrary entries are evicted —
// O(n) only in the rare over-cap path and no sort under the lock.
func (c *Cache) pruneLocked(now time.Time) {
	if len(c.items) <= l1MaxEntries {
		return
	}
	for k, e := range c.items {
		if !now.Before(e.expires) {
			delete(c.items, k)
		}
	}
	for k := range c.items {
		if len(c.items) <= l1MaxEntries {
			break
		}
		delete(c.items, k)
	}
}

// DeleteAllTokens clears every cached positive mapping in both layers. It is
// not on the request path (kept for administrative use).
func (c *Cache) DeleteAllTokens(ctx context.Context) {
	c.mu.Lock()
	c.items = make(map[string]cacheEntry)
	c.mu.Unlock()

	if !c.redisOK {
		return
	}
	var cursor uint64
	for {
		keys, next, err := c.rdb.Scan(ctx, cursor, c.ns+"*", 500).Result()
		if err != nil {
			slog.Warn("[CACHE] redis scan failed", "err", err)
			return
		}
		if len(keys) > 0 {
			if err := c.rdb.Del(ctx, keys...).Err(); err != nil {
				slog.Warn("[CACHE] redis del failed", "err", err)
			}
		}
		if next == 0 {
			return
		}
		cursor = next
	}
}
