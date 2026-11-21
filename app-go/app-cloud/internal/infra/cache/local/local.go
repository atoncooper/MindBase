// Package local provides the in-process L1 cache backend.
//
// Storage, admission and eviction are delegated to dgraph-io/ristretto v2;
// this package adds the small domain-agnostic pieces app-cloud needs:
// per-key single-flight loading, optional short TTL on failures, and the
// cache.Cache/LoadingCache contract.
package local

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	"golang.org/x/sync/singleflight"

	"app-cloud/internal/infra/cache"
)

const (
	defaultMaxEntries = 100_000
	// failureEntries are still stored in the same L1; the error TTL is chosen
	// by the caller and passed to SetWithTTL.
	defaultBufferItems = 64
)

type options struct {
	maxEntries int
	defaultTTL time.Duration
}

// Option configures a local cache.
type Option func(*options)

// WithMaxEntries bounds the number of live entries (<=0 uses the default).
func WithMaxEntries(n int) Option {
	return func(o *options) { o.maxEntries = n }
}

// WithDefaultTTL applies when Set/GetOrLoad receives a non-positive TTL.
func WithDefaultTTL(ttl time.Duration) Option {
	return func(o *options) { o.defaultTTL = ttl }
}

type entry[V any] struct {
	value     V
	err       error
	expiresAt time.Time
}

// Cache is the ristretto-backed L1 cache.
type Cache[K cache.Key, V any] struct {
	store  *ristretto.Cache[K, entry[V]]
	group  singleflight.Group
	opts   options
	closed bool
	mu     sync.RWMutex
}

var _ cache.LoadingCache[int64, string] = (*Cache[int64, string])(nil)

// New creates an in-process cache.
func New[K cache.Key, V any](opts ...Option) *Cache[K, V] {
	o := options{maxEntries: defaultMaxEntries}
	for _, opt := range opts {
		opt(&o)
	}
	maxEntries := o.maxEntries
	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}
	// Ristretto uses MaxCost as the capacity unit. One entry costs 1, so
	// MaxCost == max entries. NumCounters is 10x capacity per ristretto docs.
	store, err := ristretto.NewCache[K, entry[V]](&ristretto.Config[K, entry[V]]{
		NumCounters:        int64(maxEntries) * 10,
		MaxCost:            int64(maxEntries),
		BufferItems:        defaultBufferItems,
		IgnoreInternalCost: true,
	})
	if err != nil {
		// Invalid capacity is a programmer error, not a recoverable runtime
		// condition; New has no error return to keep the cache dependency
		// injection simple. The factory validates capacity before calling.
		panic(fmt.Sprintf("cache/local: init ristretto: %v", err))
	}
	return &Cache[K, V]{store: store, opts: o}
}

// Get returns a successful cached value. Cached failures and expired entries
// are misses for this method.
func (c *Cache[K, V]) Get(_ context.Context, key K) (V, bool) {
	entry, ok := c.lookup(key)
	if !ok || entry.err != nil {
		var zero V
		return zero, false
	}
	return entry.value, true
}

// Set stores a successful value.
func (c *Cache[K, V]) Set(_ context.Context, key K, value V, ttl time.Duration) {
	ttl = c.effectiveTTL(ttl)
	if ttl <= 0 {
		c.store.Del(key)
		return
	}
	c.store.SetWithTTL(key, entry[V]{value: value, expiresAt: time.Now().Add(ttl)}, 1, ttl)
	// Ristretto writes are buffered; wait so an immediate follow-up Get (same
	// request path, tests) sees the value instead of racing the write buffer.
	c.store.Wait()
}

// Delete removes one entry.
func (c *Cache[K, V]) Delete(_ context.Context, key K) {
	c.store.Del(key)
	c.store.Wait()
}

// Len returns the number of live entries. Ristretto has no Len method, so
// this iterates values; it is intended for observability/tests, not hot paths.
func (c *Cache[K, V]) Len() int {
	now := time.Now()
	count := 0
	c.store.IterValues(func(e entry[V]) bool {
		if now.Before(e.expiresAt) {
			count++
		}
		return true
	})
	return count
}

// Close drops all entries and prevents future writes.
func (c *Cache[K, V]) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	c.store.Close()
	return nil
}

// GetOrLoad returns a cached value or loads it once per key.
func (c *Cache[K, V]) GetOrLoad(ctx context.Context, key K, ttl, errorTTL time.Duration,
	load cache.Loader[K, V]) (V, error) {
	if entry, ok := c.lookup(key); ok {
		return entry.value, entry.err
	}

	ch := c.group.DoChan(singleflightKey(key), func() (any, error) {
		// Another goroutine may have populated the cache between our miss and
		// this leader entry; re-check to avoid a duplicate upstream call.
		if entry, ok := c.lookup(key); ok {
			return entry, nil
		}
		value, err := load(ctx, key)
		entry := entry[V]{value: value, err: err, expiresAt: time.Now().Add(c.effectiveTTL(ttl))}
		switch {
		case err != nil && errorTTL > 0:
			entry.expiresAt = time.Now().Add(errorTTL)
			c.store.SetWithTTL(key, entry, 1, errorTTL)
		case err == nil && c.effectiveTTL(ttl) > 0:
			entry.expiresAt = time.Now().Add(c.effectiveTTL(ttl))
			c.store.SetWithTTL(key, entry, 1, c.effectiveTTL(ttl))
		}
		c.store.Wait()
		return entry, nil
	})

	select {
	case <-ctx.Done():
		var zero V
		return zero, ctx.Err()
	case result := <-ch:
		if result.Err != nil {
			var zero V
			return zero, result.Err
		}
		entry, _ := result.Val.(entry[V])
		return entry.value, entry.err
	}
}

func (c *Cache[K, V]) lookup(key K) (entry[V], bool) {
	entry, ok := c.store.Get(key)
	if !ok {
		return entry, false
	}
	if !time.Now().Before(entry.expiresAt) {
		c.store.Del(key)
		return entry, false
	}
	return entry, true
}

func (c *Cache[K, V]) effectiveTTL(ttl time.Duration) time.Duration {
	if ttl > 0 {
		return ttl
	}
	return c.opts.defaultTTL
}

func singleflightKey[K cache.Key](key K) string {
	return fmt.Sprint(key)
}
