package service

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// LoginThrottle — per-identifier password brute-force defense (Redis).
// Same key namespace and semantics as the Python login_throttle: 5 failures
// within a rolling 1-hour window → 15-minute hard lockout; success clears.
// Redis unavailable → fail-open (the /auth rate-limit middleware remains).
type LoginThrottle struct {
	rdb redis.UniversalClient
}

const (
	loginFailNS         = "mind-base:login_fail:"
	loginMaxFailed      = 5
	loginWindowSeconds  = 3600
	loginLockoutSeconds = 900
)

func NewLoginThrottle(rdb redis.UniversalClient) *LoginThrottle {
	return &LoginThrottle{rdb: rdb}
}

// Check returns (allowed, retryAfterSeconds).
func (t *LoginThrottle) Check(ctx context.Context, identifier string) (bool, int) {
	if t.rdb == nil {
		return true, 0
	}
	key := loginFailNS + normalizeIdentifier(identifier)
	count, err := t.rdb.Get(ctx, key).Result()
	if err != nil {
		return true, 0 // miss or redis error → fail open
	}
	n, _ := strconv.Atoi(count)
	if n >= loginMaxFailed {
		ttl, err := t.rdb.TTL(ctx, key).Result()
		if err != nil || ttl <= 0 {
			return false, 60
		}
		return false, int(ttl.Seconds())
	}
	return true, 0
}

// RecordFailed increments the counter; sets the rolling TTL on first failure
// and extends to the hard-lockout TTL when the threshold is crossed.
func (t *LoginThrottle) RecordFailed(ctx context.Context, identifier string) {
	if t.rdb == nil {
		return
	}
	key := loginFailNS + normalizeIdentifier(identifier)
	current, err := t.rdb.Incr(ctx, key).Result()
	if err != nil {
		slog.Debug("[LOGIN_THROTTLE] incr failed", "err", err)
		return
	}
	switch {
	case current == 1:
		t.rdb.Expire(ctx, key, loginWindowSeconds*time.Second)
	case int(current) >= loginMaxFailed:
		t.rdb.Expire(ctx, key, loginLockoutSeconds*time.Second)
	}
}

// RecordSuccess clears the counter.
func (t *LoginThrottle) RecordSuccess(ctx context.Context, identifier string) {
	if t.rdb == nil {
		return
	}
	t.rdb.Del(ctx, loginFailNS+normalizeIdentifier(identifier))
}

// normalizeIdentifier mirrors the Python _normalise_email (lowercase, trim).
func normalizeIdentifier(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

// FixedWindowLimiter — generic per-key fixed-window counter (Redis INCR +
// EXPIRE), used for the /auth per-IP guard and per-uid change-password cap.
// Redis unavailable → allow (fail-open, parity with rate_limit_service).
type FixedWindowLimiter struct {
	rdb redis.UniversalClient
	ns  string
}

func NewFixedWindowLimiter(rdb redis.UniversalClient, ns string) *FixedWindowLimiter {
	return &FixedWindowLimiter{rdb: rdb, ns: ns}
}

// Allow records a hit and reports whether key is within limit per window.
func (l *FixedWindowLimiter) Allow(ctx context.Context, key string, limit int, window time.Duration) bool {
	if l.rdb == nil {
		return true
	}
	full := l.ns + key
	n, err := l.rdb.Incr(ctx, full).Result()
	if err != nil {
		return true
	}
	if n == 1 {
		l.rdb.Expire(ctx, full, window)
	}
	return n <= int64(limit)
}

// RetryAfter returns the remaining TTL of the window key (seconds), for
// Rate-After headers; 0 when the key is absent or redis is down.
func (l *FixedWindowLimiter) RetryAfter(ctx context.Context, key string) int {
	if l.rdb == nil {
		return 0
	}
	ttl, err := l.rdb.TTL(ctx, l.ns+key).Result()
	if err != nil || ttl <= 0 {
		return 0
	}
	return int(ttl.Seconds())
}
