package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/metrics"

	"github.com/redis/go-redis/v9"
)

func (s *HLSService) Enqueue(ctx context.Context, uid int64, uploadUUID string) {
	s.enqueue(ctx, uid, uploadUUID, false)
}

// enqueue is the single enqueue path. force=true is the manual retry: it
// clears a terminal status/attempt counter and queues the job again.
func (s *HLSService) enqueue(ctx context.Context, uid int64, uploadUUID string, force bool) bool {
	if !s.Enabled() || uploadUUID == "" || uid <= 0 {
		return false
	}
	if s.isGone(ctx, uploadUUID) {
		return false
	}
	if !force {
		if st, err := s.getStatus(ctx, uploadUUID); err == nil && st.Status == hlsStateReady && st.Prefix != "" {
			return false // already packaged; a duplicate event must not re-encode
		}
	}
	if force {
		pipe := s.rdb.Pipeline()
		pipe.Del(ctx, hlsJobKeyPfx+uploadUUID, hlsAttemptsPfx+uploadUUID)
		pipe.ZRem(ctx, hlsRetryKey, jobMember(hlsJob{UID: uid, UploadUUID: uploadUUID}))
		_, _ = pipe.Exec(ctx)
	}
	acquired, err := s.rdb.SetNX(ctx, hlsJobKeyPfx+uploadUUID, "1", hlsJobKeyTTL).Result()
	if err != nil {
		slog.Warn("[HLS] dedupe check failed", "upload_uuid", uploadUUID, "err", err)
		return false
	}
	if !acquired {
		return false // another enqueue (or a retry) already owns this job
	}
	body := jobMember(hlsJob{UID: uid, UploadUUID: uploadUUID})
	if err := s.rdb.LPush(ctx, hlsQueueKey, body).Err(); err != nil {
		_ = s.rdb.Del(ctx, hlsJobKeyPfx+uploadUUID).Err()
		slog.Warn("[HLS] enqueue failed", "upload_uuid", uploadUUID, "err", err)
		return false
	}
	s.setStatus(ctx, uploadUUID, hlsStatus{Status: hlsStateQueued, Progress: hlsProgressQueued})
	return true
}

// Retry requeues a video for packaging (manual user action). Ownership and the
// video MIME type are validated before anything is queued.
func (s *HLSService) Retry(ctx context.Context, uid int64, uploadUUID string) (HLSPlayback, error) {
	if s == nil || !s.Enabled() {
		return HLSPlayback{Status: "disabled"}, nil
	}
	file, err := s.files.GetByUUID(s.db, uploadUUID, uid)
	if err != nil {
		return HLSPlayback{}, err
	}
	if file == nil {
		return HLSPlayback{}, ErrNotFound
	}
	if !strings.HasPrefix(strings.ToLower(file.MimeType), "video/") {
		return HLSPlayback{Status: hlsStateUnsupported}, nil
	}
	queued := s.enqueue(ctx, uid, uploadUUID, true)
	status, _ := s.getStatus(ctx, uploadUUID)
	if status.Status == "" {
		status.Status = hlsStateQueued
	}
	if queued {
		status.Status = hlsStateQueued
	}
	return HLSPlayback{
		Ready:     false,
		Status:    status.Status,
		Progress:  status.Progress,
		Attempts:  status.Attempts,
		Retryable: status.Retryable,
	}, nil
}

func (s *HLSService) worker(ctx context.Context) {
	for {
		raw, err := s.rdb.BLMove(ctx, hlsQueueKey, hlsProcessingKey, "RIGHT", "LEFT", 5*time.Second).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			slog.Warn("[HLS] queue pop failed", "err", err)
			time.Sleep(2 * time.Second)
			continue
		}
		s.handle(ctx, raw)
	}
}

func (s *HLSService) handle(ctx context.Context, raw string) {
	defer s.removeProcessing(ctx, raw)

	var job hlsJob
	if err := json.Unmarshal([]byte(raw), &job); err != nil || job.UploadUUID == "" {
		slog.Warn("[HLS] bad job", "raw", raw, "err", err)
		return
	}

	leaseToken, ok := s.acquireLease(ctx, job.UploadUUID)
	if !ok {
		// Another replica owns this upload (duplicate delivery). The queue
		// entry is dropped; the owner still has the job in flight.
		return
	}
	defer s.releaseLease(context.WithoutCancel(ctx), job.UploadUUID, leaseToken)

	started := time.Now()
	// A duplicate job delivered after a successful run must not re-encode.
	if st, err := s.getStatus(ctx, job.UploadUUID); err == nil && st.Status == hlsStateReady && st.Prefix != "" {
		s.finishJob(ctx, job)
		return
	}

	err := s.process(ctx, job)
	metrics.HLSProcessing.Observe(time.Since(started).Seconds())
	if err == nil {
		s.finishJob(ctx, job)
		metrics.HLSJobs.WithLabelValues("ready").Inc()
		return
	}

	var jerr *hlsJobError
	if !errors.As(err, &jerr) {
		jerr = &hlsJobError{err: err, retryable: true}
	}
	if !jerr.retryable {
		s.failTerminal(ctx, job, 0, jerr)
		return
	}
	s.scheduleRetry(ctx, job, jerr)
}

func (s *HLSService) scheduleRetry(ctx context.Context, job hlsJob, cause *hlsJobError) {
	if s.isGone(ctx, job.UploadUUID) {
		s.finishJob(ctx, job)
		return
	}
	attempts := s.bumpAttempts(ctx, job.UploadUUID)
	max := s.maxAttempts()
	if attempts >= max {
		s.failTerminal(ctx, job, attempts, cause)
		return
	}
	backoff := retryBackoff(attempts)
	body := jobMember(job)
	pipe := s.rdb.Pipeline()
	pipe.ZAdd(ctx, hlsRetryKey, redis.Z{Score: float64(time.Now().Add(backoff).Unix()), Member: body})
	pipe.Expire(ctx, hlsRetryKey, 7*24*time.Hour)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("[HLS] retry schedule failed", "upload_uuid", job.UploadUUID, "err", err)
		s.failTerminal(ctx, job, attempts, cause)
		return
	}
	s.setStatus(ctx, job.UploadUUID, hlsStatus{
		Status: hlsStateQueued, Progress: hlsProgressQueued,
		Error: cause.Error(), Attempts: attempts, Retryable: true,
	})
	metrics.HLSJobs.WithLabelValues("retry").Inc()
	slog.Warn("[HLS] packaging failed, retry scheduled",
		"upload_uuid", job.UploadUUID, "attempt", attempts, "max", max, "backoff", backoff.String(), "err", cause)
}

func (s *HLSService) failTerminal(ctx context.Context, job hlsJob, attempts int, jerr *hlsJobError) {
	status := jerr.status
	if status == "" {
		status = hlsStateFailed
	}
	s.finishJob(ctx, job)
	if s.isGone(ctx, job.UploadUUID) {
		return
	}
	msg := jerr.Error()
	if jerr.err == nil {
		msg = ""
	}
	s.setStatus(ctx, job.UploadUUID, hlsStatus{
		Status: status, Error: msg, Attempts: attempts,
		Retryable: status == hlsStateFailed,
	})
	metrics.HLSJobs.WithLabelValues(status).Inc()
	slog.Warn("[HLS] packaging failed", "upload_uuid", job.UploadUUID, "status", status, "attempts", attempts, "err", msg)
}

// finishJob clears the outstanding markers for a terminal job.
func (s *HLSService) finishJob(ctx context.Context, job hlsJob) {
	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, hlsJobKeyPfx+job.UploadUUID, hlsAttemptsPfx+job.UploadUUID)
	pipe.ZRem(ctx, hlsRetryKey, jobMember(job))
	_, _ = pipe.Exec(ctx)
}

func (s *HLSService) acquireLease(ctx context.Context, uploadUUID string) (string, bool) {
	token, err := randomToken()
	if err != nil {
		return "", false
	}
	ok, err := s.rdb.SetNX(ctx, hlsLeasePfx+uploadUUID, token, s.leaseTTL()).Result()
	if err != nil {
		slog.Warn("[HLS] lease acquire failed", "upload_uuid", uploadUUID, "err", err)
		return "", false
	}
	return token, ok
}

func (s *HLSService) releaseLease(ctx context.Context, uploadUUID, token string) {
	if token == "" {
		return
	}
	_ = releaseLeaseScript.Run(ctx, s.rdb, []string{hlsLeasePfx + uploadUUID}, token).Err()
}

func (s *HLSService) removeProcessing(ctx context.Context, raw string) {
	_ = s.rdb.LRem(context.WithoutCancel(ctx), hlsProcessingKey, 1, raw).Err()
}

func (s *HLSService) bumpAttempts(ctx context.Context, uploadUUID string) int {
	key := hlsAttemptsPfx + uploadUUID
	pipe := s.rdb.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, hlsAttemptsTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return 1
	}
	n, _ := incr.Result()
	return int(n)
}

func (s *HLSService) maxAttempts() int {
	if s.cfg.HLS.MaxAttempts > 0 {
		return s.cfg.HLS.MaxAttempts
	}
	return 3
}

func (s *HLSService) leaseTTL() time.Duration {
	return time.Duration(s.cfg.HLS.TimeoutSeconds)*time.Second + 6*time.Minute
}

func retryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	backoff := hlsBaseBackoff << (attempt - 1)
	if backoff > hlsMaxBackoff {
		backoff = hlsMaxBackoff
	}
	return backoff
}
