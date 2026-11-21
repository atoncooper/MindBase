package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"app-cloud/internal/metrics"

	"github.com/redis/go-redis/v9"
)

// retryPromoter moves due retry entries into the ready queue. Push-then-remove
// (never remove-then-push) so a crash cannot lose a retry.
func (s *HLSService) retryPromoter(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := strconv.FormatInt(time.Now().Unix(), 10)
			members, err := s.rdb.ZRangeByScore(ctx, hlsRetryKey, &redis.ZRangeBy{
				Min: "-inf", Max: now, Offset: 0, Count: 50,
			}).Result()
			if err != nil {
				continue
			}
			for _, member := range members {
				if err := s.rdb.LPush(ctx, hlsQueueKey, member).Err(); err != nil {
					slog.Warn("[HLS] retry promote failed", "err", err)
					continue
				}
				_ = s.rdb.ZRem(ctx, hlsRetryKey, member).Err()
			}
			s.publishQueueDepth(ctx)
		}
	}
}

// janitor recovers jobs whose owner died: entries left in the processing list
// without a live lease are re-queued (duplicate delivery is harmless — the
// lease check drops the loser).
func (s *HLSService) janitor(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			entries, err := s.rdb.LRange(ctx, hlsProcessingKey, 0, 199).Result()
			if err != nil {
				continue
			}
			for _, raw := range entries {
				var job hlsJob
				if err := json.Unmarshal([]byte(raw), &job); err != nil || job.UploadUUID == "" {
					_ = s.rdb.LRem(ctx, hlsProcessingKey, 1, raw).Err()
					continue
				}
				live, err := s.rdb.Exists(ctx, hlsLeasePfx+job.UploadUUID).Result()
				if err != nil || live > 0 {
					continue
				}
				if err := s.rdb.LPush(ctx, hlsQueueKey, raw).Err(); err != nil {
					continue
				}
				_ = s.rdb.LRem(ctx, hlsProcessingKey, 1, raw).Err()
				metrics.HLSJobs.WithLabelValues("requeued").Inc()
				slog.Warn("[HLS] re-queued orphaned job (worker died or lease expired)", "upload_uuid", job.UploadUUID)
			}
			s.runScheduledGC(ctx)
		}
	}
}

// runScheduledGC removes version directories whose superseded playback tokens
// must have expired by now. Failures are retried in 10 minutes.
func (s *HLSService) runScheduledGC(ctx context.Context) {
	now := strconv.FormatInt(time.Now().Unix(), 10)
	members, err := s.rdb.ZRangeByScore(ctx, hlsGCKey, &redis.ZRangeBy{
		Min: "-inf", Max: now, Offset: 0, Count: 10,
	}).Result()
	if err != nil {
		return
	}
	for _, member := range members {
		var entry hlsGCEntry
		if err := json.Unmarshal([]byte(member), &entry); err != nil {
			_ = s.rdb.ZRem(ctx, hlsGCKey, member).Err()
			continue
		}
		gcCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		err := s.gcVersions(gcCtx, entry)
		cancel()
		if err != nil {
			// Keep the entry and retry later; aborting the whole pass would
			// also be fine, but one bad file must not starve the others.
			_ = s.rdb.ZAdd(ctx, hlsGCKey, redis.Z{Score: float64(time.Now().Add(10 * time.Minute).Unix()), Member: member}).Err()
			continue
		}
		_ = s.rdb.ZRem(ctx, hlsGCKey, member).Err()
	}
}

func (s *HLSService) publishQueueDepth(ctx context.Context) {
	ready, err1 := s.rdb.LLen(ctx, hlsQueueKey).Result()
	retry, err2 := s.rdb.ZCard(ctx, hlsRetryKey).Result()
	if err1 == nil && err2 == nil {
		metrics.HLSQueueDepth.Set(float64(ready + retry))
	}
}

// ── state / helpers ──────────────────────────────────────────────────
