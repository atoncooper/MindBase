package service

import (
	"context"
	"strconv"
)

// QuotaCache is the Redis-backed daily counter consumed by the internal quota
// endpoints. Nil = quota disabled (fail-open).
type QuotaCache interface {
	QuotaCount(ctx context.Context, kind string, uid int64) (int, error)
	QuotaConsume(ctx context.Context, kind string, uid int64) (int, error)
}

// quotaDefaults mirror the Python quiz.limits defaults.
var quotaDefaults = map[string]int{"generate": 5, "grade": 20}

func (s *Store) quotaLimit(kind string) int {
	if s.QuotaLimits != nil {
		if v, ok := s.QuotaLimits[kind]; ok && v > 0 {
			return v
		}
	}
	return quotaDefaults[kind]
}

func quotaMessage(kind string, limit int) string {
	label := "出题"
	if kind == "grade" {
		label = "批改"
	}
	return "今日" + label + "次数已达上限（" + strconv.Itoa(limit) + " 次/天）"
}

// QuotaPeek returns a 429 APIError when the daily quota is already exhausted
// (nil = allowed; fail-open when Redis is unavailable / unconfigured).
func (s *Store) QuotaPeek(ctx context.Context, uid int64, kind string) *APIError {
	if s.Quota == nil {
		return nil
	}
	limit := s.quotaLimit(kind)
	count, err := s.Quota.QuotaCount(ctx, kind, uid)
	if err != nil {
		return nil
	}
	if count >= limit {
		return apiErr(429, quotaMessage(kind, limit))
	}
	return nil
}

// QuotaConsume increments the daily counter; 429 when the increment crosses the
// limit (the increment still stands — Python parity).
func (s *Store) QuotaConsume(ctx context.Context, uid int64, kind string) *APIError {
	if s.Quota == nil {
		return nil
	}
	limit := s.quotaLimit(kind)
	count, err := s.Quota.QuotaConsume(ctx, kind, uid)
	if err != nil {
		return nil
	}
	if count > limit {
		return apiErr(429, quotaMessage(kind, limit))
	}
	return nil
}
