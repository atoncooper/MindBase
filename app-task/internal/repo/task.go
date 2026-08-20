// Package repo: data access for the scheduler's task table (app-task's own
// MySQL). Pure scheduling — no business models.
package repo

import (
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
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

// CreateNextCronTask clones a terminal cron task into a fresh pending task at
// the given trigger time. Business data travels inside the opaque payload.
func CreateNextCronTask(src *model.Task, triggerTime time.Time) (string, error) {
	taskID := uuid.NewString()
	j := &model.Task{
		TaskID:       taskID,
		UID:         src.UID,
		TriggerTime: triggerTime,
		Status:      "pending",
		TaskType:     src.TaskType,
		Payload:     src.Payload,
		ExecutorURL: src.ExecutorURL,
		Async:       src.Async,
		CronExpr:    src.CronExpr,
		MaxRetry:    src.MaxRetry,
		Weight:      src.Weight,
	}
	if err := CreateTask(j); err != nil {
		return "", err
	}
	return taskID, nil
}

// MarkCronExtended links a terminal cron task to its generated next occurrence.
// Idempotent: only succeeds while cron_next_task_id is still empty.
func MarkCronExtended(taskID, nextTaskID string) (bool, error) {
	tx := db.DB.Model(&model.Task{}).
		Where("task_id = ? AND (cron_next_task_id IS NULL OR cron_next_task_id = '')", taskID).
		Updates(map[string]any{"cron_next_task_id": nextTaskID, "updated_at": time.Now().UTC()})
	return tx.RowsAffected > 0, tx.Error
}
