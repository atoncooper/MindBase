package service

import (
	"context"
	"sync"
	"time"

	"app-user/internal/config"

	"github.com/redis/go-redis/v9"
)

// RateLimits — per-endpoint fixed-window guards backed by Redis (fail-open).
// Rules come from config (security.rate_limit, defaults mirror the Python
// backend's security.rate_limit.* settings). Dimension is encoded in the key
// by the caller: ip:<addr> / tgt:<identifier> / uid:<id>.
type RateLimits struct {
	limiter *FixedWindowLimiter
	rules   map[string]config.RateLimitRule
	local   *localFixedWindow
}

func NewRateLimits(rdb redis.UniversalClient, rules map[string]config.RateLimitRule) *RateLimits {
	return &RateLimits{
		limiter: NewFixedWindowLimiter(rdb, "mind-base:rl:auth-ep:"),
		rules:   rules,
		local:   newLocalFixedWindow(),
	}
}

// Allow records a hit under rule <name> for the given dimension value and
// reports whether it is within the limit. Returns (allowed, retryAfterSeconds).
// Unknown rule or disabled window (window=0) → allow.
func (r *RateLimits) Allow(ctx context.Context, name, dimension string) (bool, int) {
	rule, ok := r.rules[name]
	if !ok || rule.Window <= 0 || rule.Max <= 0 {
		return true, 0
	}
	key := name + ":" + dimension
	if r.limiter.Allow(ctx, key, rule.Max, time.Duration(rule.Window)*time.Second) {
		return true, 0
	}
	return false, r.limiter.RetryAfter(ctx, key)
}

// AllowStrict is the security-critical variant: if Redis is unavailable, it
// falls back to an in-process fixed window instead of failing open. This keeps
// the DB protected during a Redis outage (at the cost of per-instance rather
// than cluster-wide counting).
func (r *RateLimits) AllowStrict(ctx context.Context, name, dimension string) (bool, int) {
	rule, ok := r.rules[name]
	if !ok || rule.Window <= 0 || rule.Max <= 0 {
		return true, 0
	}
	key := name + ":" + dimension
	allowed, err := r.limiter.AllowResult(ctx, key, rule.Max, time.Duration(rule.Window)*time.Second)
	if err != nil {
		ok, retry := r.local.Allow(key, rule.Max, time.Duration(rule.Window)*time.Second)
		return ok, retry
	}
	if allowed {
		return true, 0
	}
	return false, r.limiter.RetryAfter(ctx, key)
}

type localWindow struct {
	count int
	reset time.Time
}

type localFixedWindow struct {
	mu      sync.Mutex
	windows map[string]localWindow
}

func newLocalFixedWindow() *localFixedWindow {
	return &localFixedWindow{windows: make(map[string]localWindow)}
}

func (l *localFixedWindow) Allow(key string, limit int, window time.Duration) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.windows) > 100_000 {
		for k, w := range l.windows {
			if !now.Before(w.reset) {
				delete(l.windows, k)
			}
		}
	}
	w := l.windows[key]
	if !now.Before(w.reset) {
		w = localWindow{reset: now.Add(window)}
	}
	w.count++
	l.windows[key] = w
	if w.count <= limit {
		return true, 0
	}
	retry := int((w.reset.Sub(now) + time.Second - 1) / time.Second)
	if retry < 1 {
		retry = 1
	}
	return false, retry
}
