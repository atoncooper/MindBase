package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// VectorTaskRepo — durable outbox for the vectorize pipeline
// (cloud_vector_tasks). One row per upload_uuid; workers claim with
// FOR UPDATE SKIP LOCKED so any number of app-cloud replicas can drain the
// queue without double-processing. See service/workerpool.go.
type VectorTaskRepo struct{}

func NewVectorTaskRepo() *VectorTaskRepo { return &VectorTaskRepo{} }

// Enqueue inserts the task (or resets an existing row) and returns. Reset
// semantics: a row currently "processing" on some replica is left untouched —
// its claiming worker owns it; the janitor recovers it if that replica dies.
// last_error is cleared on (re)enqueue: the next run's outcome overwrites it.
func (r *VectorTaskRepo) Enqueue(db *gorm.DB, uploadUUID string, uid int64) error {
	return db.Exec(
		"INSERT INTO cloud_vector_tasks (upload_uuid, uid, status, created_at, updated_at) "+
			"VALUES (?, ?, 'pending', NOW(), NOW()) "+
			"ON DUPLICATE KEY UPDATE "+
			"status = IF(status = 'processing', status, 'pending'), "+
			"attempts = IF(status = 'processing', attempts, 0), "+
			"claimed_by = IF(status = 'processing', claimed_by, NULL), "+
			"claimed_at = IF(status = 'processing', claimed_at, NULL), "+
			"last_error = NULL, "+
			"updated_at = NOW()",
		uploadUUID, uid).Error
}

// ClaimNext atomically claims the oldest pending task, or returns (nil, nil)
// when the queue is empty. SKIP LOCKED is what makes this multi-replica safe:
// concurrent claimers skip each other's locked row instead of blocking, so no
// task is ever claimed twice.
func (r *VectorTaskRepo) ClaimNext(db *gorm.DB, workerID string) (*model.CloudVectorTask, error) {
	var claimed *model.CloudVectorTask
	err := db.Transaction(func(tx *gorm.DB) error {
		var id int64
		if err := tx.Raw(
			"SELECT id FROM cloud_vector_tasks WHERE status = 'pending' " +
				"ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
		).Scan(&id).Error; err != nil {
			return err
		}
		if id == 0 {
			return nil // queue empty
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

// RequeueStale returns tasks whose claim is older than the cutoff to the
// pending state (crash/kill recovery). RunSync's idempotency guard makes the
// eventual re-run safe.
func (r *VectorTaskRepo) RequeueStale(db *gorm.DB, olderThan time.Time) (int64, error) {
	res := db.Model(&model.CloudVectorTask{}).
		Where("status = ? AND claimed_at IS NOT NULL AND claimed_at < ?", "processing", olderThan).
		Updates(map[string]any{
			"status":     "pending",
			"claimed_by": nil,
			"claimed_at": nil,
			"updated_at": time.Now(),
		})
	return res.RowsAffected, res.Error
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
	for len(cut) > 0 && cut[len(cut)-1]&0xC0 == 0x80 {
		cut = cut[:len(cut)-1]
	}
	return cut
}
