// Package service: the scheduler's business-neutral services. app-task only
// registers tasks, dispatches them to executors, and records outcomes — all
// business logic lives in third-party executors.
package service

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// TaskService handles task registration and async completion callbacks.
type TaskService struct{}

func NewTaskService() *TaskService {
	return &TaskService{}
}

// RegisterTask registers a pure scheduling task: task_type selects the executor
// (http by default; lua for the optional built-in script executor),
// executor_url points at a third-party executor for http tasks, payload is
// passed to the executor verbatim (the scheduler never interprets it).
//
// Scheduling: cron_expr empty = one-shot (triggerTime used as-is); otherwise
// the first occurrence is computed from the cron expression. Recurring tasks
// are extended by the scheduler once they reach a terminal state.
func (s *TaskService) RegisterTask(uid int64, taskType string, payload []byte, executorURL string, async bool, cronExpr string, triggerTime time.Time, maxRetry, weight int) (string, error) {
	if taskType == "" {
		taskType = "http"
	}
	if weight <= 0 {
		weight = 1
	}
	if maxRetry < 0 {
		maxRetry = 0
	}
	if cronExpr != "" {
		next, err := NextCronTrigger(cronExpr, time.Now())
		if err != nil {
			return "", fmt.Errorf("invalid cron_expr: %w", err)
		}
		triggerTime = next
	}
	taskID := uuid.NewString()
	task := &model.Task{
		TaskID:       taskID,
		UID:         uid,
		TaskType:     taskType,
		TriggerTime: triggerTime,
		Status:      "pending",
		MaxRetry:    maxRetry,
		Weight:      weight,
	}
	if len(payload) > 0 {
		task.Payload = datatypes.JSON(payload)
	}
	if executorURL != "" {
		task.ExecutorURL = executorURL
	}
	task.Async = async
	if cronExpr != "" {
		task.CronExpr = cronExpr
	}
	if err := repo.CreateTask(task); err != nil {
		return "", fmt.Errorf("create task: %w", err)
	}
	slog.Info("[JOB] registered", "task_id", taskID, "task_type", taskType, "executor_url", executorURL, "async", async, "cron", cronExpr, "max_retry", maxRetry, "weight", weight, "trigger", formatBeijing(triggerTime))
	return taskID, nil
}

// CompleteTask handles the async callback from a third-party executor
// (POST /internal/task/{id}/complete): running -> completed|failed. Idempotent:
// a repeated callback returns the current status unchanged.
func (s *TaskService) CompleteTask(taskID, status, result, errMsg string) (string, error) {
	task, err := repo.GetTaskByID(taskID)
	if err != nil {
		return "", err
	}
	if task == nil {
		return "", errors.New("task not found")
	}
	toStatus := "completed"
	if status != "completed" {
		toStatus = "failed"
	}
	var lastResult *string
	if result != "" || errMsg != "" {
		s := result
		if errMsg != "" {
			if s != "" {
				s += "; "
			}
			s += "err: " + errMsg
		}
		lastResult = &s
	}
	updated, _ := repo.ConditionalUpdate(taskID, "running", toStatus, map[string]any{"last_result": lastResult})
	if !updated {
		// Idempotent: already terminal (or raced). Return current status.
		cur, _ := repo.GetTaskByID(taskID)
		if cur != nil {
			return cur.Status, nil
		}
		return "", nil
	}
	var errField *string
	if errMsg != "" {
		errField = &errMsg
	}
	_ = repo.CreateTaskLog(&model.TaskLog{
		LogID:    uuid.NewString(),
		TaskID:    taskID,
		Executor: task.ExecutorURL,
		Response: result,
		Status:   toStatus,
		Error:    errField,
	})
	slog.Info("[JOB] completed via callback", "task_id", taskID, "status", toStatus)
	return toStatus, nil
}
