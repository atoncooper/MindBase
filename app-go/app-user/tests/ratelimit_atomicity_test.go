package tests

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	authservice "app-user/internal/service/auth"

	"github.com/redis/go-redis/v9"
)

// newIntegrationRedis returns a live Redis client or skips the test. These
// cases exist because the limiter's failure mode is a Redis key without a TTL,
// which a fake/in-memory double cannot reproduce faithfully. Run against the
// dev stack with:
//
//	docker run --rm --network mind-base-net -e APPUSER_TEST_REDIS_ADDR=mind-base-redis:6379 //	  -e APPUSER_TEST_REDIS_PASSWORD=mind-base -v "$PWD/app-go/app-user":/src -w /src //	  golang:1.25-alpine go test ./tests -run 'RateLimit|FixedWindow|LoginThrottle'
func newIntegrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := os.Getenv("APPUSER_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("APPUSER_TEST_REDIS_ADDR not set; skipping Redis integration test")
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: os.Getenv("APPUSER_TEST_REDIS_PASSWORD"),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

// TestFixedWindowLimiterAtomicTTL pins the regression behind the /account
// "请求过于频繁，请稍后再试" outage: a counter key that exists without a TTL
// must never survive — every Allow must (re)arm the window expiry, because
// only the first increment used to do so.
func TestFixedWindowLimiterAtomicTTL(t *testing.T) {
	rdb := newIntegrationRedis(t)
	ctx := context.Background()
	ns := fmt.Sprintf("mind-base:test:rl:fixed:%d:", time.Now().UnixNano())
	t.Cleanup(func() {
		keys, _ := rdb.Keys(ctx, ns+"*").Result()
		if len(keys) > 0 {
			_ = rdb.Del(ctx, keys...).Err()
		}
	})
	l := authservice.NewFixedWindowLimiter(rdb, ns)

	// 1) First hit arms the TTL atomically (fresh key).
	key := "ip:203.0.113.7"
	if !l.Allow(ctx, key, 3, 30*time.Second) {
		t.Fatal("first request must be allowed")
	}
	if ttl := rdb.PTTL(ctx, ns+key).Val(); ttl <= 0 {
		t.Fatalf("window TTL not armed: PTTL=%v", ttl)
	}

	// 2) A poisoned key (counter, no TTL) is repaired by the next hit and the
	//    rejection carries a usable Retry-After instead of 0.
	poisoned := "ip:203.0.113.99"
	if err := rdb.Set(ctx, ns+poisoned, 1000, 0).Err(); err != nil {
		t.Fatalf("seed poisoned key: %v", err)
	}
	if l.Allow(ctx, poisoned, 3, 30*time.Second) {
		t.Fatal("poisoned key is over the limit and must be rejected")
	}
	if ttl := rdb.PTTL(ctx, ns+poisoned).Val(); ttl <= 0 {
		t.Fatalf("poisoned key not repaired: PTTL=%v", ttl)
	}
	if retry := l.RetryAfter(ctx, poisoned); retry < 1 {
		t.Fatalf("Retry-After must be >= 1s for a blocked key, got %d", retry)
	}

	// 3) Fixed-window semantics: an existing TTL is not extended by later hits.
	before := rdb.PTTL(ctx, ns+key).Val()
	_ = l.Allow(ctx, key, 100, 30*time.Second)
	after := rdb.PTTL(ctx, ns+key).Val()
	if after > before {
		t.Fatalf("window TTL must not slide: before=%v after=%v", before, after)
	}
}

// TestLoginThrottleLockoutTTLUsedToBePermanent covers the same lost-TTL class
// on the brute-force lockout key: a lockout counter without a TTL must be
// re-armed rather than locking the identifier+IP out forever.
func TestLoginThrottleLockoutTTL(t *testing.T) {
	rdb := newIntegrationRedis(t)
	ctx := context.Background()
	identifier := fmt.Sprintf("ratelimit-test-%d@example.invalid", time.Now().UnixNano())
	ip := "203.0.113.42"
	throttle := authservice.NewLoginThrottle(rdb)

	keyPattern := "mind-base:login_fail:" + identifier + "|" + ip
	t.Cleanup(func() { _ = rdb.Del(context.Background(), keyPattern).Err() })

	for i := 0; i < 2; i++ {
		throttle.RecordFailed(ctx, identifier, ip)
	}
	if ttl := rdb.PTTL(ctx, keyPattern).Val(); ttl <= 0 {
		t.Fatalf("failure window TTL not armed: PTTL=%v", ttl)
	}
	// Simulate the poisoned state and make sure the next failure repairs it.
	if err := rdb.Persist(ctx, keyPattern).Err(); err != nil {
		t.Fatalf("persist: %v", err)
	}
	throttle.RecordFailed(ctx, identifier, ip)
	if ttl := rdb.PTTL(ctx, keyPattern).Val(); ttl <= 0 {
		t.Fatalf("poisoned lockout key not repaired: PTTL=%v", ttl)
	}

	// Crossing the threshold moves the key to the hard-lockout TTL.
	for i := 0; i < 3; i++ {
		throttle.RecordFailed(ctx, identifier, ip)
	}
	if ttl := rdb.PTTL(ctx, keyPattern).Val(); ttl <= 0 || ttl > 915*time.Second {
		t.Fatalf("lockout TTL not applied: PTTL=%v", ttl)
	}
	allowed, retry := throttle.Check(ctx, identifier, ip)
	if allowed || retry < 1 {
		t.Fatalf("locked out identifier must be rejected with Retry-After >= 1s, got allowed=%v retry=%d", allowed, retry)
	}
}
