// Package cache provides the hot-path token→uid cache: L1 in-process memory
// plus optional L2 Redis (enabled when a redis URL is configured). Semantics
// mirror the Python backend's auth cache (5-minute TTL, delete on revoke).
package cache

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Cache struct {
	ns      string
	ttl     time.Duration
	mu      sync.RWMutex
	items   map[string]cacheEntry
	rdb     redis.UniversalClient
	redisOK bool
}

type cacheEntry struct {
	uid     int64
	expires time.Time
}

// New builds a cache. redisURL empty = memory only (same degradation as the
// Python backend's optional L2).
func New(redisURL, namespace string, ttl time.Duration) (*Cache, error) {
	c := &Cache{
		ns:    namespace,
		ttl:   ttl,
		items: make(map[string]cacheEntry),
	}
	if strings.TrimSpace(redisURL) == "" {
		return c, nil
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	rdb := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		// Redis down at boot must not block startup — same fail-open stance
		// as the Python backend; L1 still works.
		slog.Warn("[CACHE] redis unavailable, memory-only token cache", "err", err)
		return c, nil
	}
	c.rdb = rdb
	c.redisOK = true
	return c, nil
}

// Close releases the Redis connection if any.
func (c *Cache) Close() error {
	if c.rdb != nil {
		return c.rdb.Close()
	}
	return nil
}

func (c *Cache) key(token string) string { return c.ns + token }

// GetTokenUID returns the cached uid for a token, or 0 on miss.
func (c *Cache) GetTokenUID(ctx context.Context, token string) int64 {
	now := time.Now()
	c.mu.RLock()
	if e, ok := c.items[token]; ok && now.Before(e.expires) {
		c.mu.RUnlock()
		return e.uid
	}
	c.mu.RUnlock()

	if !c.redisOK {
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
	c.items[token] = cacheEntry{uid: uid, expires: now.Add(c.ttl)}
	c.mu.Unlock()
	return uid
}

// SetTokenUID caches a token→uid mapping in L1 (+L2 when available).
func (c *Cache) SetTokenUID(ctx context.Context, token string, uid int64) {
	now := time.Now()
	c.mu.Lock()
	c.items[token] = cacheEntry{uid: uid, expires: now.Add(c.ttl)}
	// opportunistic cleanup to bound memory
	if len(c.items) > 100_000 {
		for k, e := range c.items {
			if now.After(e.expires) {
				delete(c.items, k)
			}
		}
	}
	c.mu.Unlock()

	if c.redisOK {
		if err := c.rdb.Set(ctx, c.key(token), uid, c.ttl).Err(); err != nil {
			slog.Warn("[CACHE] redis set failed", "err", err)
		}
	}
}

// DeleteToken drops a token from both layers (revoke path).
func (c *Cache) DeleteToken(ctx context.Context, token string) {
	c.mu.Lock()
	delete(c.items, token)
	c.mu.Unlock()
	if c.redisOK {
		_ = c.rdb.Del(ctx, c.key(token)).Err()
	}
}

// DeleteAllTokens clears every cached mapping in both layers (used by
// revoke-all-for-user). The namespace-scoped key pattern keeps the Redis
// scan bounded — this cache only ever holds auth tokens.
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
