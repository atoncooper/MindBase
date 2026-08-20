// Package repo: data access for the scheduler's execution log.
package repo

import (
	"app-task/internal/db"
	"app-task/internal/model"
)

// CreateTaskLog appends one execution record (every trigger writes a log).
func CreateTaskLog(l *model.TaskLog) error {
	return db.DB.Create(l).Error
}

// ListTaskLogs returns the execution trail for a task, newest first.
func ListTaskLogs(taskID string, limit int) ([]model.TaskLog, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []model.TaskLog
	err := db.DB.Where("task_id = ?", taskID).
		Order("id DESC").Limit(limit).Find(&out).Error
	return out, err
}

// ListRecentLogs returns the most recent execution logs across all tasks
// (admin console), optionally filtered by task_id.
func ListRecentLogs(taskID string, limit int) ([]model.TaskLog, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []model.TaskLog
	q := db.DB.Order("id DESC")
	if taskID != "" {
		q = q.Where("task_id = ?", taskID)
	}
	err := q.Limit(limit).Find(&out).Error
	return out, err
}

// CountTaskLogs returns the total number of execution records (dashboard).
func CountTaskLogs() (int64, error) {
	var n int64
	err := db.DB.Model(&model.TaskLog{}).Count(&n).Error
	return n, err
}
