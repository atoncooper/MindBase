package service

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// LoginThrottle — per-(identifier, IP) password brute-force defense (Redis).
// Keying the hard lockout by identifier+IP avoids the classic "lock any known
// account with 5 bad passwords from anywhere" DoS: an attacker can only lock
// their own source, while the per-identifier /auth rate-limit rule still caps
// distributed guessing. Redis unavailable → fail-open (the /auth rate-limit
// middleware remains).
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
func (t *LoginThrottle) Check(ctx context.Context, identifier, ip string) (bool, int) {
	if t.rdb == nil {
		return true, 0
	}
	key := loginFailNS + loginThrottleKey(identifier, ip)
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

// loginFailScript is INCR + EXPIRE in one atomic step (same lost-TTL hazard as
// fixedWindowScript below: a separate EXPIRE can be dropped/reordered, and
// since only the first failure used to arm the TTL, a poisoned lockout key
// never expires — Check would then keep answering 429 for that
// identifier+IP until someone deleted the key by hand).
var loginFailScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
elseif n >= tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
elseif ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`)

// RecordFailed increments the counter; sets the rolling TTL on first failure
// and extends to the hard-lockout TTL when the threshold is crossed.
func (t *LoginThrottle) RecordFailed(ctx context.Context, identifier, ip string) {
	if t.rdb == nil {
		return
	}
	key := loginFailNS + loginThrottleKey(identifier, ip)
	_, err := loginFailScript.Run(ctx, t.rdb, []string{key},
		loginWindowSeconds*1000, loginMaxFailed, loginLockoutSeconds*1000).Int64()
	if err != nil {
		slog.Debug("[LOGIN_THROTTLE] incr failed", "err", err)
	}
}

// RecordSuccess clears the counter.
func (t *LoginThrottle) RecordSuccess(ctx context.Context, identifier, ip string) {
	if t.rdb == nil {
		return
	}
	t.rdb.Del(ctx, loginFailNS+loginThrottleKey(identifier, ip))
}

// loginThrottleKey scopes the hard lockout to the source IP.
func loginThrottleKey(identifier, ip string) string {
	return normalizeIdentifier(identifier) + "|" + strings.TrimSpace(ip)
}

// normalizeIdentifier mirrors the Python _normalise_email (lowercase, trim).
func normalizeIdentifier(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

// fixedWindowScript is the whole fixed-window check in ONE atomic Redis step:
// INCR the counter and (re)install the window TTL together.
//
// Why a script instead of INCR followed by EXPIRE: the two commands were sent
// as separate pool commands, and go-redis may hand them to different
// connections — they are therefore not ordered. EXPIRE could reach Redis
// before INCR (a no-op on a missing key), leaving the counter created without
// any TTL. Since only the first increment armed the TTL, such a key never
// expired: every later request incremented it, always exceeded the limit, and
// that client IP got 429 "请求过于频繁，请稍后再试" with Retry-After: 0
// *forever* (only a manual DEL or a Redis restart recovered it — observed in
// production on /account, where the poisoned key for the host gateway IP made
// every /auth/* request look rate-limited). The ttl < 0 branch also repairs
// keys already poisoned before this fix, so an upgrade needs no Redis surgery.
var fixedWindowScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`)

// FixedWindowLimiter — generic per-key fixed-window counter (Redis, atomic
// INCR+PEXPIRE script), used for the /auth per-IP guard and per-uid
// change-password cap. Redis unavailable → allow (fail-open, parity with
// rate_limit_service).
type FixedWindowLimiter struct {
	rdb redis.UniversalClient
	ns  string
}

func NewFixedWindowLimiter(rdb redis.UniversalClient, ns string) *FixedWindowLimiter {
	return &FixedWindowLimiter{rdb: rdb, ns: ns}
}

// AllowResult records a hit and returns (allowed, error). Callers that protect
// a database can use error to choose fail-closed/local fallback instead of
// silently disabling the limit when Redis is down.
func (l *FixedWindowLimiter) AllowResult(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	if l.rdb == nil {
		return false, errors.New("redis unavailable")
	}
	ms := window.Milliseconds()
	if ms <= 0 {
		ms = 1
	}
	n, err := fixedWindowScript.Run(ctx, l.rdb, []string{l.ns + key}, ms).Int64()
	if err != nil {
		return false, err
	}
	return n <= int64(limit), nil
}

// Allow records a hit and reports whether key is within limit per window.
// Login/registration callers keep the historical fail-open behavior; the
// forward-auth path uses RateLimits.AllowStrict with a local fallback.
func (l *FixedWindowLimiter) Allow(ctx context.Context, key string, limit int, window time.Duration) bool {
	ok, err := l.AllowResult(ctx, key, limit, window)
	if err != nil {
		return true
	}
	return ok
}

// RetryAfter returns the remaining TTL of the window key (seconds, rounded up
// so a sub-second remainder still yields a usable Retry-After header); 0 when
// the key is absent, has no expiry, or redis is down.
func (l *FixedWindowLimiter) RetryAfter(ctx context.Context, key string) int {
	if l.rdb == nil {
		return 0
	}
	ttl, err := l.rdb.TTL(ctx, l.ns+key).Result()
	if err != nil {
		return 0
	}
	if ttl <= 0 {
		// Defensive: a blocked key should always carry a TTL after the atomic
		// script above, but never tell the client "retry after 0s".
		return 1
	}
	return int((ttl + time.Second - 1) / time.Second)
}
