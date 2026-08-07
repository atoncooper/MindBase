// Package repo: data access for task_quiz_task (MySQL).
package repo

import (
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

func CreateTask(t *model.TaskQuizTask) error {
	return db.DB.Create(t).Error
}

func GetTaskByID(taskID string) (*model.TaskQuizTask, error) {
	var t model.TaskQuizTask
	err := db.DB.Where("task_id = ?", taskID).First(&t).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &t, err
}

func ListTasksByUID(uid int64, limit, offset int) ([]model.TaskQuizTask, error) {
	var tasks []model.TaskQuizTask
	err := db.DB.Where("uid = ?", uid).Order("created_at DESC").
		Limit(limit).Offset(offset).Find(&tasks).Error
	return tasks, err
}

// ConditionalUpdate atomically transitions status only if current == fromStatus.
// Prevents the completed-vs-overdue race (loser's RowsAffected==0).
func ConditionalUpdate(taskID, fromStatus, toStatus string, extra map[string]any) (bool, error) {
	values := map[string]any{"status": toStatus, "updated_at": time.Now().UTC()}
	for k, v := range extra {
		values[k] = v
	}
	tx := db.DB.Model(&model.TaskQuizTask{}).
		Where("task_id = ? AND status = ?", taskID, fromStatus).
		Updates(values)
	return tx.RowsAffected > 0, tx.Error
}

// ListDuePending returns pending tasks whose trigger_time has passed.
// Used by the scheduler worker to fire execute_quiz.
func ListDuePending(limit int) ([]model.TaskQuizTask, error) {
	var tasks []model.TaskQuizTask
	err := db.DB.Where("status = ? AND trigger_time <= ?", "pending", time.Now().UTC()).
		Order("trigger_time ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ListOverdueSent returns sent tasks whose deadline has passed.
// Used by the scheduler worker to fire check_timeout.
func ListOverdueSent(limit int) ([]model.TaskQuizTask, error) {
	var tasks []model.TaskQuizTask
	err := db.DB.Where("status = ? AND deadline IS NOT NULL AND deadline <= ?", "sent", time.Now().UTC()).
		Order("deadline ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// ListGenerating returns tasks in "generating" state (async quiz generation in
// progress at the main app). The scheduler polls /status for these each tick.
func ListGenerating(limit int) ([]model.TaskQuizTask, error) {
	var tasks []model.TaskQuizTask
	err := db.DB.Where("status = ?", "generating").
		Order("updated_at ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}
