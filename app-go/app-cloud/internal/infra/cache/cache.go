// Package cache defines backend-agnostic contracts for app-cloud caches.
//
// The package is deliberately small and Go-idiomatic: consumers depend on the
// narrow interface they use, implementations live in subpackages, and the
// factory package wires a backend without leaking it into callers.
package cache

import (
	"context"
	"time"
)

// Key is the set of comparable key types supported by the cache backends.
// It intentionally mirrors ristretto's key constraint so a local L1 can be
// backed directly by the library.
type Key interface {
	~uint64 | ~string | ~byte | ~int | ~uint | ~int32 | ~uint32 | ~int64
}

// Cache is the minimal key/value contract shared by all backends.
//
// Get returns false both for a real miss and for a cached failure entry;
// callers that need failure semantics use LoadingCache.GetOrLoad.
type Cache[K Key, V any] interface {
	Get(ctx context.Context, key K) (V, bool)
	Set(ctx context.Context, key K, value V, ttl time.Duration)
	Delete(ctx context.Context, key K)
	Len() int
	Close() error
}

// Loader loads a missing value for a key.
type Loader[K Key, V any] func(ctx context.Context, key K) (V, error)

// LoadingCache adds single-flight loading on top of Cache.
//
// GetOrLoad coalesces concurrent misses for the same key into one loader
// call. When load returns an error, implementations may cache that error for
// errorTTL (<=0 disables failure caching) and return the loader's value
// together with the error. This is what lets the quota path keep serving a
// fail-closed "free" tier without hammering app-pay during an outage.
type LoadingCache[K Key, V any] interface {
	Cache[K, V]
	GetOrLoad(ctx context.Context, key K, ttl, errorTTL time.Duration,
		load Loader[K, V]) (V, error)
}
