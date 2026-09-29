// Package repo: data access for the scheduler's task table (app-task's own
// MySQL). Pure scheduling — no business models.
package repo

import (
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func CreateTask(j *model.Task) error {
	return db.DB.Create(j).Error
}

func GetTaskByID(taskID string) (*model.Task, error) {
	var j model.Task
	err := db.DB.Where("task_id = ?", taskID).First(&j).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &j, err
}

func ListTasksByUID(uid int64, limit, offset int) ([]model.Task, error) {
	var tasks []model.Task
	err := db.DB.Where("uid = ?", uid).Order("created_at DESC").
		Limit(limit).Offset(offset).Find(&tasks).Error
	return tasks, err
}

// ListAllTasks returns tasks across all users, newest first (admin console).
// Empty status = no status filter.
func ListAllTasks(status string, limit, offset int) ([]model.Task, error) {
	var tasks []model.Task
	q := db.DB.Order("created_at DESC")
	if status != "" {
		q = q.Where("status = ?", status)
	}
	err := q.Limit(limit).Offset(offset).Find(&tasks).Error
	return tasks, err
}

// CountTasks counts tasks, optionally filtered by status.
func CountTasks(status string) (int64, error) {
	var n int64
	q := db.DB.Model(&model.Task{})
	if status != "" {
		q = q.Where("status = ?", status)
	}
	err := q.Count(&n).Error
	return n, err
}

// CountTasksByStatus returns task counts grouped by status (dashboard).
func CountTasksByStatus() (map[string]int64, error) {
	var rows []struct {
		Status string `gorm:"column:status"`
		Count  int64  `gorm:"column:count"`
	}
	err := db.DB.Model(&model.Task{}).
		Select("status, COUNT(*) AS count").
		Group("status").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[r.Status] = r.Count
	}
	return out, nil
}

// ConditionalUpdate atomically transitions status only if current == fromStatus.
// Prevents concurrent dispatchers from double-executing a task.
func ConditionalUpdate(taskID, fromStatus, toStatus string, extra map[string]any) (bool, error) {
	values := map[string]any{"status": toStatus, "updated_at": time.Now().UTC()}
	for k, v := range extra {
		values[k] = v
	}
	tx := db.DB.Model(&model.Task{}).
		Where("task_id = ? AND status = ?", taskID, fromStatus).
		Updates(values)
	return tx.RowsAffected > 0, tx.Error
}

// ListDuePending returns pending tasks whose trigger_time (or retry window)
// has passed. Used by the scheduler to fire executions.
func ListDuePending(limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := db.DB.Where(
		"status = ? AND trigger_time <= ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
		"pending", time.Now().UTC(), time.Now().UTC(),
	).Order("trigger_time ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// Task status dispatching: claimed by a scheduler worker, dispatch in flight.
// Transient — finalized to completed/running/failed/pending by the worker, or
// reclaimed back to pending after the dispatching timeout.
const StatusDispatching = "dispatching"

// ClaimTask atomically claims one pending task for dispatch: the conditional
// update makes competing workers/instances mutually exclusive (exactly one
// claim succeeds). Returns the fresh fencing token and whether the claim won.
// (The scheduler uses ClaimTasksBatch — same guarantee, one transaction per
// batch.)
func ClaimTask(taskID, owner string, now time.Time) (string, bool, error) {
	token := uuid.NewString()
	res := db.DB.Model(&model.Task{}).
		Where("task_id = ? AND status = ?", taskID, "pending").
		Updates(map[string]any{
			"status":      StatusDispatching,
			"owner":       owner,
			"claimed_at":  now,
			"claim_token": token,
			"updated_at":  now,
		})
	return token, res.RowsAffected > 0, res.Error
}

// ClaimTasksBatch claims up to `limit` due pending tasks for one dispatch
// wave. Within a transaction the candidate rows are read and flipped to
// dispatching together:
//   - MySQL: the SELECT takes FOR UPDATE SKIP LOCKED row locks, so concurrent
//     instances read disjoint candidate sets — a contention-free efficiency
//     win (no competing UPDATE churn), NOT the correctness guarantee. The
//     guarantee is the status='pending' filter inside the same transaction.
//   - Other dialects (SQLite tests) skip the locking clause; mutual exclusion
//     comes from the transaction + status filter.
func ClaimTasksBatch(limit int, owner string, now time.Time) ([]model.Task, error) {
	var claimed []model.Task
	err := db.DB.Transaction(func(tx *gorm.DB) error {
		q := tx.Where(
			"status = ? AND trigger_time <= ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
			"pending", now, now,
		).Order("trigger_time ASC").Limit(limit)
		if tx.Dialector.Name() == "mysql" {
			q = q.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"})
		}
		var candidates []model.Task
		if err := q.Find(&candidates).Error; err != nil {
			return err
		}
		if len(candidates) == 0 {
			return nil
		}
		ids := make([]string, 0, len(candidates))
		for i := range candidates {
			ids = append(ids, candidates[i].TaskID)
		}
		// The rows are locked (MySQL) / the tx isolated (SQLite): every
		// candidate still reads status=pending, so the update normally claims
		// all of them. One fencing token per batch — every re-claim mints a
		// fresh token, which is what finalizes are fenced against.
		batchToken := uuid.NewString()
		if err := tx.Model(&model.Task{}).
			Where("task_id IN ? AND status = ?", ids, "pending").
			Updates(map[string]any{
				"status":      StatusDispatching,
				"owner":       owner,
				"claimed_at":  now,
				"claim_token": batchToken,
				"updated_at":  now,
			}).Error; err != nil {
			return err
		}
		// Re-select by token instead of trusting the candidate list: only rows
		// THIS transaction actually flipped (token matches) may be dispatched.
		// If a concurrent claimant had already taken some candidates (possible
		// only without the locking clause), they are silently dropped here —
		// correctness never depends on the lock, only on the status filter +
		// token readback.
		if err := tx.Where("owner = ? AND claim_token = ?", owner, batchToken).
			Find(&claimed).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, nil
}

// ReleaseClaim returns a claimed (dispatching) task to pending WITHOUT
// counting a retry — used when the pool/executor gate is saturated at
// dispatch time so the task cannot start. Fenced by the claim token: only the
// current holder may release. trigger_time/next_retry_at are untouched: the
// task stays immediately due for the next tick.
func ReleaseClaim(taskID, claimToken string) (bool, error) {
	return FinalizeClaim(taskID, claimToken, "pending", nil)
}

// FinalizeClaim transitions a dispatching claim to its outcome, FENCED by the
// claim token: only the current holder may finalize. A stale holder whose
// claim was reclaimed and re-dispatched (e.g. it stalled past the dispatching
// TTL while its executor call was still in flight) cannot clobber the newer
// claim — the caller discards its result as orphaned. This is what turns the
// at-least-once execution model into exactly-once state transitions.
func FinalizeClaim(taskID, claimToken, toStatus string, extra map[string]any) (bool, error) {
	values := map[string]any{"status": toStatus, "updated_at": time.Now().UTC()}
	for k, v := range extra {
		values[k] = v
	}
	tx := db.DB.Model(&model.Task{}).
		Where("task_id = ? AND status = ? AND claim_token = ?", taskID, StatusDispatching, claimToken).
		Updates(values)
	return tx.RowsAffected > 0, tx.Error
}

// ListStaleDispatching returns dispatching tasks whose claim is older than the
// dispatching timeout (crashed instance / lost worker). Candidates for reclaim.
func ListStaleDispatching(olderThan time.Time, limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := db.DB.Where("status = ? AND claimed_at < ?", StatusDispatching, olderThan).
		Order("claimed_at ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ReclaimDispatching flips stale dispatching claims back to pending so the
// next tick re-dispatches them (at-least-once: the original dispatch may have
// fired — executors must be idempotent). Returns the number of reclaimed rows.
func ReclaimDispatching(olderThan time.Time) (int64, error) {
	res := db.DB.Model(&model.Task{}).
		Where("status = ? AND claimed_at < ?", StatusDispatching, olderThan).
		Updates(map[string]any{
			"status":      "pending",
			"owner":       "",
			"claimed_at":  nil,
			"claim_token": "",
			"updated_at":  time.Now().UTC(),
		})
	return res.RowsAffected, res.Error
}

// ListRunning returns tasks in the async "running" state awaiting a callback.
func ListRunning(limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := db.DB.Where("status = ?", "running").
		Order("updated_at ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ListCronTasksToExtend returns terminal cron tasks whose next occurrence has
// not been generated yet (cron_next_task_id still empty).
func ListCronTasksToExtend(limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := db.DB.Where(
		"cron_expr IS NOT NULL AND cron_expr <> '' AND (cron_next_task_id IS NULL OR cron_next_task_id = '') AND status IN ?",
		[]string{"completed", "failed"},
	).Order("updated_at ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ExtendCronTask clones a terminal cron task into its next pending occurrence,
// ATOMICALLY: the conditional link update is the claim (exactly one instance
// wins — the loser's link update matches zero rows) and the insert happens
// inside the same transaction only for the winner. This is what prevents the
// orphan-duplicate race where two concurrent extensions both INSERTed a next
// occurrence and only the loser's link was rejected, leaving an unlinked
// duplicate that would fire an extra time.
func ExtendCronTask(src *model.Task, triggerTime time.Time) (string, bool, error) {
	nextID := uuid.NewString()
	won := false
	err := db.DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Task{}).
			Where("task_id = ? AND (cron_next_task_id IS NULL OR cron_next_task_id = '')", src.TaskID).
			Updates(map[string]any{"cron_next_task_id": nextID, "updated_at": time.Now().UTC()})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // another instance won the extension: do NOT insert
		}
		won = true
		return tx.Create(&model.Task{
			TaskID:      nextID,
			UID:         src.UID,
			TriggerTime: triggerTime,
			Status:      "pending",
			TaskType:    src.TaskType,
			Payload:     src.Payload,
			ExecutorURL: src.ExecutorURL,
			Async:       src.Async,
			CronExpr:    src.CronExpr,
			MaxRetry:    src.MaxRetry,
			Weight:      src.Weight,
		}).Error
	})
	if err != nil {
		return "", false, err
	}
	return nextID, won, nil
}
