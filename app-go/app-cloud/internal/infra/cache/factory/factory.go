// Package factory selects and constructs a cache backend.
//
// Callers depend on cache.LoadingCache, never on the concrete backend. Today
// only the local L1 backend exists; a future cache/redis backend can be added
// here without changing the service layer.
package factory

import (
	"fmt"
	"time"

	"app-cloud/internal/infra/cache"
	"app-cloud/internal/infra/cache/local"
)

// Backend names a cache implementation.
type Backend string

const (
	// Local is the in-process L1 cache.
	Local Backend = "local"
)

// Config describes the selected backend. Backend-specific fields are added
// here as backends appear; callers only need the fields relevant to them.
type Config struct {
	Backend    Backend
	MaxEntries int
	DefaultTTL time.Duration
}

// New constructs a LoadingCache for the requested backend.
func New[K cache.Key, V any](cfg Config) (cache.LoadingCache[K, V], error) {
	switch cfg.Backend {
	case "", Local:
		return local.New[K, V](
			local.WithMaxEntries(cfg.MaxEntries),
			local.WithDefaultTTL(cfg.DefaultTTL),
		), nil
	default:
		return nil, fmt.Errorf("cache: unsupported backend %q", cfg.Backend)
	}
}
