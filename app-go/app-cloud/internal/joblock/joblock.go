// Package joblock — Redis-backed lease for periodic background jobs.
//
// Why: runTrashSweeper / runDailyReconciler are in-process tickers. With more
// than one app-cloud replica every instance would run the same sweep — N
// replicas racing over the same purge batch (MinIO/Mongo/Milvus deletes).
// A short-lived Redis lease (SET NX PX + token-guarded release) makes each
// tick single-winner with no extra coordination service: the first SET wins,
// every other replica's tick is a no-op for that round.
//
// Crash safety: the lease TTL must comfortably exceed the job's context
// timeout, so a crashed holder cannot deadlock the job — another replica
// takes over once the lease expires. Release is compare-and-delete Lua, so a
// stale holder can never delete the current owner's lease.
package joblock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/redis/go-redis/v9"
)

// keyPrefix mirrors the existing app-cloud Redis namespace
// (mind-base:cloud:upload:* / mind-base:cloud:pending:*).
const keyPrefix = "mind-base:cloud:lock:"

// releaseScript deletes the lease only when the stored token still matches —
// i.e. it is still OUR lease. Without this guard, an expired-then-reacquired
// lease held by replica B could be deleted by replica A's late release.
const releaseScript = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

// TryAcquire attempts to acquire the named lease for ttl. Returns
// (release, true) on success — release is non-nil and idempotent — and
// (nil, false) when another instance holds the lease or Redis errored
// (fail-closed: skipping a tick is safer than N replicas sweeping).
//
// A nil client (Redis unavailable at boot, main.go degradation path) degrades
// to (no-op release, true): single-replica behaviour is preserved unchanged.
func TryAcquire(ctx context.Context, rdb redis.UniversalClient, name string, ttl time.Duration) (func(), bool) {
	if rdb == nil {
		return func() {}, true
	}
	key := keyPrefix + name
	token, err := newToken()
	if err != nil {
		return nil, false
	}
	ok, err := rdb.SetNX(ctx, key, token, ttl).Result()
	if err != nil || !ok {
		return nil, false
	}
	var released bool
	// Release deliberately uses context.Background(): the acquire ctx is
	// usually already canceled by the time the job finishes, and a canceled
	// Eval would leave the lease stuck until TTL expiry.
	return func() {
		if released {
			return
		}
		released = true
		_ = rdb.Eval(context.Background(), releaseScript, []string{key}, token).Err()
	}, true
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
