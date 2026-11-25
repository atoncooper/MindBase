package settings

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"
)

// Provider model lists are cached in Redis (never in MySQL): they are volatile
// third-party data, and asking the provider on every chat turn is both slow and
// rate-limit hostile. The user can force a refresh from the Coding Plan page.
const codingPlanModelsCachePrefix = "mind-base:coding-plan:models:"

func (s *CodingPlanService) modelsCacheKey(planID int64) string {
	return codingPlanModelsCachePrefix + strconv.FormatInt(planID, 10)
}

func (s *CodingPlanService) cachedModels(ctx context.Context, planID int64) ([]string, bool) {
	if s.redis == nil || s.modelsTTL <= 0 {
		return nil, false
	}
	raw, err := s.redis.Get(ctx, s.modelsCacheKey(planID)).Bytes()
	if err != nil {
		return nil, false
	}
	var models []string
	if err := json.Unmarshal(raw, &models); err != nil {
		return nil, false
	}
	return models, true
}

func (s *CodingPlanService) storeModels(ctx context.Context, planID int64, models []string) {
	if s.redis == nil || s.modelsTTL <= 0 || len(models) == 0 {
		return
	}
	raw, err := json.Marshal(models)
	if err != nil {
		return
	}
	if err := s.redis.Set(ctx, s.modelsCacheKey(planID), raw, s.modelsTTL).Err(); err != nil {
		slog.Warn("[CODING_PLAN] models cache write failed", "plan_id", planID, "err", err)
	}
}

func (s *CodingPlanService) invalidateModels(ctx context.Context, planID int64) {
	if s.redis == nil {
		return
	}
	if err := s.redis.Del(ctx, s.modelsCacheKey(planID)).Err(); err != nil {
		slog.Warn("[CODING_PLAN] models cache invalidate failed", "plan_id", planID, "err", err)
	}
}

// cacheTTL exposes the configured TTL for tests/logging.
func (s *CodingPlanService) cacheTTL() time.Duration { return s.modelsTTL }
