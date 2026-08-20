package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
)

// Scheduler polls the DB for due tasks and dispatches them to the executor
// registered for each task's task_type. Pure scheduling: the executor (HTTP to
// a third-party service, or the optional built-in Lua executor) does the
// work; the scheduler records every execution in task_log and advances the
// task state machine.
//
// State machine:
//   pending -> completed            (sync 2xx)
//   pending -> running -> completed | failed   (async callback)
//   pending/failed -> pending       (retry with next_retry_at)
//   running > 10m without callback  -> failed (timeout)
type Scheduler struct {
	registry *executor.Registry
	interval time.Duration
	stopCh   chan struct{}
}

func NewScheduler(reg *executor.Registry, intervalSec int) *Scheduler {
	return &Scheduler{
		registry: reg,
		interval: time.Duration(intervalSec) * time.Second,
		stopCh:   make(chan struct{}),
	}
}

func (s *Scheduler) Start() {
	go s.loop()
	slog.Info("[SCHEDULER] started", "interval", s.interval, "handlers", s.registry.Types())
}

func (s *Scheduler) Stop() {
	select {
	case <-s.stopCh:
	default:
		close(s.stopCh)
	}
	slog.Info("[SCHEDULER] stopped")
}

func (s *Scheduler) loop() {
	s.tick() // fire once immediately (catch up after restart)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

func (s *Scheduler) tick() {
	// 0. Extend recurring (cron) tasks into their next occurrence.
	s.extendCronTasks()

	// 1. Fire due pending tasks by dispatching to the handler for task_type.
	due, err := repo.ListDuePending(50)
	if err != nil {
		slog.Error("[SCHEDULER] list due pending failed", "err", err)
	}
	for _, j := range due {
		s.dispatch(&j)
	}

	// 2. Async tasks stuck in running without a callback -> timeout -> failed.
	running, err := repo.ListRunning(50)
	if err != nil {
		slog.Error("[SCHEDULER] list running failed", "err", err)
	}
	for _, j := range running {
		if time.Since(j.UpdatedAt) > 10*time.Minute {
			slog.Warn("[SCHEDULER] running timeout (>10m), marking failed", "task_id", j.TaskID, "age", time.Since(j.UpdatedAt))
			if _, _ = repo.ConditionalUpdate(j.TaskID, "running", "failed", nil); true {
				s.writeLog(&j, "timeout", 0, "", "no callback within 10m")
			}
		}
	}
}

// dispatch hands one due task to the executor handler and records the outcome
// in task_log. Sync success -> completed; ErrAsync -> running (callback will
// finalize); other errors -> retry policy or failed.
func (s *Scheduler) dispatch(task *model.Task) {
	start := time.Now()
	h, ok := s.registry.Handler(task.TaskType)
	if !ok {
		slog.Error("[SCHEDULER] no handler for task_type", "task_type", task.TaskType, "task_id", task.TaskID)
		s.markFailedOrRetry(task, fmt.Errorf("no handler for task type %q", task.TaskType), start)
		return
	}
	err := h(context.Background(), taskFromTask(task))
	if err == nil {
		// Sync success -> completed.
		if ok, _ := repo.ConditionalUpdate(task.TaskID, "pending", "completed", map[string]any{"last_result": "ok"}); ok {
			s.writeLog(task, "success", time.Since(start).Milliseconds(), "ok", "")
		}
		return
	}
	if errors.Is(err, executor.ErrAsync) {
		// Async accepted -> running; the executor reports via callback.
		if _, _ = repo.ConditionalUpdate(task.TaskID, "pending", "running", nil); true {
			s.writeLog(task, "accepted", time.Since(start).Milliseconds(), "", "")
		}
		return
	}
	s.markFailedOrRetry(task, err, start)
}

// markFailedOrRetry applies the task's retry policy to a failed dispatch:
// schedule a retry (back to pending with retry_count+1 and next_retry_at at
// an exponential backoff, capped) while retries remain, otherwise fail. The
// outcome is always recorded in task_log.
func (s *Scheduler) markFailedOrRetry(task *model.Task, err error, start time.Time) {
	duration := time.Since(start).Milliseconds()
	errMsg := err.Error()
	if task.MaxRetry > 0 && task.RetryCount < task.MaxRetry {
		shift := task.RetryCount
		if shift > 30 {
			shift = 30
		}
		backoff := time.Duration(1<<uint(shift)) * time.Second // 1s, 2s, 4s…
		if backoff > 5*time.Minute {
			backoff = 5 * time.Minute
		}
		next := time.Now().UTC().Add(backoff)
		ok, _ := repo.ConditionalUpdate(task.TaskID, task.Status, "pending",
			map[string]any{"retry_count": task.RetryCount + 1, "next_retry_at": next})
		if ok {
			s.writeLog(task, "retry", duration, "", errMsg)
			slog.Warn("[SCHEDULER] retry scheduled", "task_id", task.TaskID, "task_type", task.TaskType, "retry", task.RetryCount+1, "next_retry_at", formatBeijing(next), "err", errMsg)
			return
		}
	}
	if _, _ = repo.ConditionalUpdate(task.TaskID, task.Status, "failed", nil); true {
		s.writeLog(task, "failed", duration, "", errMsg)
		slog.Error("[SCHEDULER] task failed", "task_id", task.TaskID, "task_type", task.TaskType, "err", errMsg)
	}
}

// writeLog appends one execution record to task_log (溯源).
func (s *Scheduler) writeLog(task *model.Task, status string, durationMS int64, response, errMsg string) {
	var errField *string
	if errMsg != "" {
		errField = &errMsg
	}
	_ = repo.CreateTaskLog(&model.TaskLog{
		LogID:      uuid.NewString(),
		TaskID:      task.TaskID,
		Executor:   executorName(task),
		Request:    truncate(string(task.Payload), 1000),
		Response:   truncate(response, 2000),
		Status:     status,
		DurationMS: durationMS,
		Error:      errField,
	})
}

func executorName(task *model.Task) string {
	if task.TaskType == "lua" {
		return "lua"
	}
	if task.ExecutorURL != "" {
		return task.ExecutorURL
	}
	return task.TaskType
}

// taskFromTask adapts the persisted task into the generic executor.Task view.
// Handlers never see the concrete model — only ID/payload/meta.
func taskFromTask(j *model.Task) executor.Task {
	return executor.Task{
		ID:      j.TaskID,
		Payload: j.Payload,
		Meta: map[string]any{
			"uid":          j.UID,
			"status":       j.Status,
			"task_type":     j.TaskType,
			"executor_url": j.ExecutorURL,
			"async":        j.Async,
			"retry_count":  j.RetryCount,
		},	
	}
}

// extendCronTasks clones terminal cron tasks into their next pending
// occurrence. cron_next_task_id guards against duplicate clones.
func (s *Scheduler) extendCronTasks() {
	toExtend, err := repo.ListCronTasksToExtend(50)
	if err != nil {
		slog.Error("[SCHEDULER] list cron extend failed", "err", err)
		return
	}
	for _, j := range toExtend {
		next, err := NextCronTrigger(j.CronExpr, time.Now())
		if err != nil {
			slog.Error("[SCHEDULER] cron parse failed", "task_id", j.TaskID, "cron_expr", j.CronExpr, "err", err)
			continue
		}
		newID, err := repo.CreateNextCronTask(&j, next)
		if err != nil {
			slog.Error("[SCHEDULER] create next cron task failed", "task_id", j.TaskID, "err", err)
			continue
		}
		ok, err := repo.MarkCronExtended(j.TaskID, newID)
		if err != nil {
			slog.Error("[SCHEDULER] mark cron extended failed", "task_id", j.TaskID, "err", err)
			continue
		}
		if !ok {
			continue
		}
		slog.Info("[SCHEDULER] cron extended", "task_id", j.TaskID, "next_task_id", newID, "next", formatBeijing(next))
	}
}
