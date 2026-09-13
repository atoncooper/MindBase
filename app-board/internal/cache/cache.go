// Package cache provides the read cache for board metadata/bodies.
//
// Design rules (see service/board.go):
//   - Cache-aside on READ paths only (detail + list). Writes (PUT optimistic
//     lock) always commit to MySQL first — version authority is never cached.
//   - Every write invalidates the affected keys immediately; TTL is only the
//     backstop for rare read-modify races.
//   - Redis being down must NEVER break correctness: every error degrades to
//     a cache miss and the query falls through to the stores.
package cache

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// CacheStore is the read-cache contract implemented by RedisCache (prod),
// InMemoryCache (tests) and NoopCache (cache disabled / tests).
type CacheStore interface {
	// Get returns the cached value; miss (or any error) -> ("", false).
	Get(ctx context.Context, key string) (string, bool)
	// Set stores value with the cache's TTL.
	Set(ctx context.Context, key, value string)
	// Del removes exact keys (missing keys are fine).
	Del(ctx context.Context, keys ...string)
	// DelByPrefix removes every key starting with prefix (list pages of a user).
	DelByPrefix(ctx context.Context, prefix string)
}

// ── Redis ───────────────────────────────────────────────────────────

type RedisCache struct {
	RDB *redis.Client
	TTL time.Duration
}

func NewRedis(rdb *redis.Client, ttl time.Duration) *RedisCache {
	return &RedisCache{RDB: rdb, TTL: ttl}
}

// warnThrottled logs at most one warning per window per op: with Redis down,
// every request would otherwise emit warnings and flood the log stream.
var warnThrottled = newWarnThrottle(time.Minute)

type warnThrottler struct {
	mu     sync.Mutex
	last   map[string]time.Time
	window time.Duration
}

func newWarnThrottle(window time.Duration) *warnThrottler {
	return &warnThrottler{last: map[string]time.Time{}, window: window}
}

func (t *warnThrottler) allow(op string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	if last, ok := t.last[op]; ok && now.Sub(last) < t.window {
		return false
	}
	t.last[op] = now
	return true
}

func (c *RedisCache) Get(ctx context.Context, key string) (string, bool) {
	v, err := c.RDB.Get(ctx, key).Result()
	if err != nil {
		if err != redis.Nil && warnThrottled.allow("get") {
			// Degrade, never fail the request: the stores are authoritative.
			slog.WarnContext(ctx, "[CACHE] redis get failed, falling through (throttled 1/min)", "err", err)
		}
		return "", false
	}
	return v, true
}

func (c *RedisCache) Set(ctx context.Context, key, value string) {
	if err := c.RDB.Set(ctx, key, value, c.TTL).Err(); err != nil && warnThrottled.allow("set") {
		slog.WarnContext(ctx, "[CACHE] redis set failed (throttled 1/min)", "err", err)
	}
}

func (c *RedisCache) Del(ctx context.Context, keys ...string) {
	if len(keys) == 0 {
		return
	}
	if err := c.RDB.Del(ctx, keys...).Err(); err != nil && warnThrottled.allow("del") {
		slog.WarnContext(ctx, "[CACHE] redis del failed (throttled 1/min)", "err", err)
	}
}

// DelByPrefix uses SCAN (non-blocking) — the key space here is per-user list
// pages, tiny by construction. KEYS would be acceptable at this scale too,
// but SCAN never blocks Redis regardless.
func (c *RedisCache) DelByPrefix(ctx context.Context, prefix string) {
	var batch []string
	iter := c.RDB.Scan(ctx, 0, prefix+"*", 100).Iterator()
	for iter.Next(ctx) {
		batch = append(batch, iter.Val())
		if len(batch) >= 100 {
			c.Del(ctx, batch...)
			batch = batch[:0]
		}
	}
	if err := iter.Err(); err != nil && warnThrottled.allow("scan") {
		slog.WarnContext(ctx, "[CACHE] redis scan failed (throttled 1/min)", "err", err)
		return
	}
	c.Del(ctx, batch...)
}

// ── In-memory (tests / dev without Redis) ──────────────────────────

type InMemoryCache struct {
	mu  sync.Mutex
	val map[string]string
}

func NewInMemory() *InMemoryCache {
	return &InMemoryCache{val: map[string]string{}}
}

func (c *InMemoryCache) Get(_ context.Context, key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.val[key]
	return v, ok
}

func (c *InMemoryCache) Set(_ context.Context, key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.val[key] = value
}

func (c *InMemoryCache) Del(_ context.Context, keys ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range keys {
		delete(c.val, k)
	}
}

func (c *InMemoryCache) DelByPrefix(_ context.Context, prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.val {
		if strings.HasPrefix(k, prefix) {
			delete(c.val, k)
		}
	}
}

// ── Noop ────────────────────────────────────────────────────────────

// NoopCache disables caching entirely (URL empty / unit tests): every Get is
// a miss, writes are no-ops, so all reads fall through to the stores.
type NoopCache struct{}

func (NoopCache) Get(context.Context, string) (string, bool) { return "", false }
func (NoopCache) Set(context.Context, string, string)        {}
func (NoopCache) Del(context.Context, ...string)             {}
func (NoopCache) DelByPrefix(context.Context, string)        {}
