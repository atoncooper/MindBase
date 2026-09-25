package service

import (
	"context"
	"time"

	"app-auth/internal/config"

	"github.com/redis/go-redis/v9"
)

// RateLimits — per-endpoint fixed-window guards backed by Redis (fail-open).
// Rules come from config (security.rate_limit, defaults mirror the Python
// backend's security.rate_limit.* settings). Dimension is encoded in the key
// by the caller: ip:<addr> / tgt:<identifier> / uid:<id>.
type RateLimits struct {
	limiter *FixedWindowLimiter
	rules   map[string]config.RateLimitRule
}

func NewRateLimits(rdb redis.UniversalClient, rules map[string]config.RateLimitRule) *RateLimits {
	return &RateLimits{
		limiter: NewFixedWindowLimiter(rdb, "mind-base:rl:auth-ep:"),
		rules:   rules,
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
