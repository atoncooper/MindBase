package redisstore

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// QuotaKey builds the canonical daily-quota key
// (mind-base:quiz_quota:{kind}:{uid}:{YYYYMMDD}) — the SAME key/format the
// Python backend's app/services/llm/quiz_quota.py uses, so both stacks share
// one counter during the cutover.
func (s *Store) QuotaKey(kind string, uid int64) string {
	day := time.Now().UTC().Format("20060102")
	return s.key("quiz_quota", kind, strconv.FormatInt(uid, 10), day)
}

// QuotaCount returns the current daily count. Miss / disabled / error all
// return (0, nil) so callers fail open (Python parity).
func (s *Store) QuotaCount(ctx context.Context, kind string, uid int64) (int, error) {
	if !s.Enabled() {
		return 0, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	n, err := s.client.Get(callCtx, s.QuotaKey(kind, uid)).Int()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// QuotaConsume increments the daily counter and returns the new count (the
// first increment arms the 24h TTL; Python parity).
func (s *Store) QuotaConsume(ctx context.Context, kind string, uid int64) (int, error) {
	if !s.Enabled() {
		return 0, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	key := s.QuotaKey(kind, uid)
	n, err := s.client.Incr(callCtx, key).Result()
	if err != nil {
		return 0, err
	}
	if n == 1 {
		_ = s.client.Expire(callCtx, key, 24*time.Hour).Err()
	}
	return int(n), nil
}
