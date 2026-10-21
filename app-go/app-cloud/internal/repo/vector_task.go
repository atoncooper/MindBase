package repo

import (
	"time"
	"unicode/utf8"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// VectorTaskRepo — durable outbox for the vectorize pipeline
// (cloud_vector_tasks). One row per upload_uuid; workers claim with
// FOR UPDATE SKIP LOCKED so any number of app-cloud replicas can drain the
// queue without double-processing. See service/workerpool.go.
type VectorTaskRepo struct{}

func NewVectorTaskRepo() *VectorTaskRepo { return &VectorTaskRepo{} }

// Enqueue inserts the task (or resets an existing row). status is the
// caller-decided PRIORITY ('pending' for paid tiers, 'pending_low' for free)
// — encoded in the status value itself because the guard tests forbid ALTERs
// on app-cloud tables. Reset semantics: a row currently "processing" on some
// replica is left untouched — its claiming worker owns it; the janitor
// recovers it if that replica dies. last_error is cleared on (re)enqueue.
func (r *VectorTaskRepo) Enqueue(db *gorm.DB, uploadUUID string, uid int64, status string) error {
	return db.Exec(
		"INSERT INTO cloud_vector_tasks (upload_uuid, uid, status, created_at, updated_at) "+
			"VALUES (?, ?, ?, NOW(), NOW()) "+
			"ON DUPLICATE KEY UPDATE "+
			"status = IF(status = 'processing', status, ?), "+
			"attempts = IF(status = 'processing', attempts, 0), "+
			"claimed_by = IF(status = 'processing', claimed_by, NULL), "+
			"claimed_at = IF(status = 'processing', claimed_at, NULL), "+
			"last_error = NULL, "+
			"updated_at = NOW()",
		uploadUUID, uid, status, status).Error
}

// ClaimNext claims the oldest task, PAID TIERS FIRST: 'pending' (paid) is
// drained before 'pending_low' (free). Within a tier it is FIFO by id. No
// preemption: in-flight low-priority runs finish before a high-priority task
// is picked up — bounded by the per-run timeout. SKIP LOCKED is what makes
// this multi-replica safe: concurrent claimers skip each other's locked row
// instead of blocking, so no task is ever claimed twice.
func (r *VectorTaskRepo) ClaimNext(db *gorm.DB, workerID string) (*model.CloudVectorTask, error) {
	for _, status := range []string{"pending", "pending_low"} {
		t, err := r.claimOne(db, workerID, status)
		if err != nil || t != nil {
			return t, err
		}
	}
	return nil, nil
}

func (r *VectorTaskRepo) claimOne(db *gorm.DB, workerID, status string) (*model.CloudVectorTask, error) {
	var claimed *model.CloudVectorTask
	err := db.Transaction(func(tx *gorm.DB) error {
		var id int64
		if err := tx.Raw(
			"SELECT id FROM cloud_vector_tasks WHERE status = ? "+
				"ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED", status,
		).Scan(&id).Error; err != nil {
			return err
		}
		if id == 0 {
			return nil // queue empty for this tier
		}
		now := time.Now()
		if err := tx.Model(&model.CloudVectorTask{}).Where("id = ?", id).Updates(map[string]any{
			"status":     "processing",
			"claimed_by": workerID,
			"claimed_at": now,
			"attempts":   gorm.Expr("attempts + 1"),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		var t model.CloudVectorTask
		if err := tx.First(&t, id).Error; err != nil {
			return err
		}
		claimed = &t
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}

// RequeueCandidate — one outbox row selected for requeue.
type RequeueCandidate struct {
	ID         int64
	UID        int64
	UploadUUID string
}

// Finish terminates a task row (done/failed). errMsg is truncated to fit
// last_error varchar(500).
func (r *VectorTaskRepo) Finish(db *gorm.DB, id int64, status, errMsg string) error {
	return db.Model(&model.CloudVectorTask{}).Where("id = ?", id).Updates(map[string]any{
		"status":     status,
		"last_error": truncateErr(errMsg),
		"updated_at": time.Now(),
	}).Error
}

// FinishByUploadUUID closes the task by file — used by the user-facing
// stale-processing reconciliation so the janitor doesn't resurrect a task the
// user has already been told failed.
func (r *VectorTaskRepo) FinishByUploadUUID(db *gorm.DB, uploadUUID, status, errMsg string) error {
	return db.Model(&model.CloudVectorTask{}).Where("upload_uuid = ?", uploadUUID).Updates(map[string]any{
		"status":     status,
		"last_error": truncateErr(errMsg),
		"updated_at": time.Now(),
	}).Error
}

// RequeueStaleCandidates returns rows stuck in "processing" past the cutoff
// (crash/kill recovery input). The caller decides the requeue priority via
// RequeueIDs — janitor-side tier resolution keeps this repo policy-free.
func (r *VectorTaskRepo) RequeueStaleCandidates(db *gorm.DB, olderThan time.Time) ([]RequeueCandidate, error) {
	var out []RequeueCandidate
	err := db.Raw("SELECT id, uid, upload_uuid FROM cloud_vector_tasks "+
		"WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ?", olderThan).Scan(&out).Error
	return out, err
}

// RequeueIDs returns the given rows to the caller-chosen status.
func (r *VectorTaskRepo) RequeueIDs(db *gorm.DB, status string, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	res := db.Model(&model.CloudVectorTask{}).Where("id IN ?", ids).Updates(map[string]any{
		"status":     status,
		"claimed_by": nil,
		"claimed_at": nil,
		"updated_at": time.Now(),
	})
	return res.RowsAffected, res.Error
}

// Retry policy for terminal-failed tasks. Bounded by MaxTaskAttempts TOTAL
// claims (the attempts counter already exists — deliberately no schema
// change: guard tests forbid ALTERs on app-cloud tables). Fixed backoff
// between attempts via updated_at; a reprocess (Enqueue) resets attempts so
// a manual re-trigger always gets a fresh budget.
const (
	// MaxTaskAttempts — claims per task, user re-triggers included.
	MaxTaskAttempts = 3
	// FailedRetryBackoff — minimum age of a failed row before the janitor
	// requeues it for the next attempt.
	FailedRetryBackoff = 2 * time.Minute
	// StaleReconciledMsg — terminal error written by the user-facing stale
	// processing reconciliation. Retries exclude rows carrying it: the user
	// has been told "failed" and the janitor must not resurrect them.
	StaleReconciledMsg = "stale processing reconciled"
)

// RequeueFailedCandidates returns terminal-failed rows eligible for the
// bounded retry (attempts budget + backoff age; rows the user-facing stale
// reconciliation already terminalised are excluded via staleMsg).
func (r *VectorTaskRepo) RequeueFailedCandidates(db *gorm.DB, olderThan time.Time, maxAttempts int, staleMsg string) ([]RequeueCandidate, error) {
	var out []RequeueCandidate
	err := db.Raw("SELECT id, uid, upload_uuid FROM cloud_vector_tasks "+
		"WHERE status = 'failed' AND attempts > 0 AND attempts < ? AND updated_at < ? "+
		"AND (last_error IS NULL OR last_error <> ?)", maxAttempts, olderThan, staleMsg).Scan(&out).Error
	return out, err
}

// RequeueOneWithFiles returns one row to the caller-chosen priority status
// and flips the file's vector_status back to pending in the same transaction
// (the user sees a truthful "queued again" while the retry is scheduled).
func (r *VectorTaskRepo) RequeueOneWithFiles(db *gorm.DB, c RequeueCandidate, status string) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.CloudVectorTask{}).Where("id = ?", c.ID).Updates(map[string]any{
			"status":     status,
			"claimed_by": nil,
			"claimed_at": nil,
			"updated_at": time.Now(),
		}).Error; err != nil {
			return err
		}
		return tx.Exec("UPDATE cloud_files SET vector_status = 'pending', updated_at = NOW() "+
			"WHERE upload_uuid = ? AND vector_status = 'failed'", c.UploadUUID).Error
	})
}

// CountStates returns (pending, pendingLow, processing) row counts —
// queue-depth observability for the peak-shaving buffer.
func (r *VectorTaskRepo) CountStates(db *gorm.DB) (pending int64, pendingLow int64, processing int64, err error) {
	var out struct {
		Pending    int64
		PendingLow int64
		Processing int64
	}
	if err = db.Raw(
		"SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, "+
			"COALESCE(SUM(status = 'pending_low'), 0) AS pending_low, "+
			"COALESCE(SUM(status = 'processing'), 0) AS processing FROM cloud_vector_tasks",
	).Scan(&out).Error; err != nil {
		return 0, 0, 0, err
	}
	return out.Pending, out.PendingLow, out.Processing, nil
}

// CountInFlightForUID returns the user's pending+pending_low+processing task count —
// admission-control input.
func (r *VectorTaskRepo) CountInFlightForUID(db *gorm.DB, uid int64) (int64, error) {
	var n int64
	err := db.Model(&model.CloudVectorTask{}).Where("uid = ? AND status IN ?", uid,
		[]string{"pending", "pending_low", "processing"}).Count(&n).Error
	return n, err
}

// truncateErr bounds an error string to last_error varchar(500) without
// splitting a multi-byte rune at the boundary (Chinese error messages are
// common here).
func truncateErr(s string) string {
	const max = 500
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	// Strip an incomplete trailing rune: DecodeLastRuneInString reports
	// RuneError/size 1 for a missing-continuation tail (a lead byte alone is
	// just as invalid as a bare continuation byte).

	for len(cut) > 0 {
		if r, size := utf8.DecodeLastRuneInString(cut); !(r == utf8.RuneError && size == 1) {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut
}
