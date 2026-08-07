package service

import (
	"log/slog"
	"time"

	"app-task/internal/repo"
)

// Scheduler polls the DB for due tasks and fires ExecuteQuiz / CheckTimeout.
// No external scheduler (xxl-job/APScheduler) - just a ticker + DB state.
// Restart-safe: relies on task status + trigger_time/deadline in MySQL.
type Scheduler struct {
	taskSvc  *TaskService
	interval time.Duration
	stopCh   chan struct{}
}

func NewScheduler(taskSvc *TaskService, intervalSec int) *Scheduler {
	return &Scheduler{
		taskSvc:  taskSvc,
		interval: time.Duration(intervalSec) * time.Second,
		stopCh:   make(chan struct{}),
	}
}

func (s *Scheduler) Start() {
	go s.loop()
	slog.Info("[SCHEDULER] started", "interval", s.interval)
}

func (s *Scheduler) Stop() {
	select {
	case <-s.stopCh:
		// already closed
	default:
		close(s.stopCh)
	}
	slog.Info("[SCHEDULER] stopped")
}

func (s *Scheduler) loop() {
	// fire once immediately on start (catch up on overdue tasks after restart),
	// then on each tick.
	s.tick()
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
	// 1. Fire pending tasks whose trigger_time has passed.
	due, err := repo.ListDuePending(50)
	if err != nil {
		slog.Error("[SCHEDULER] list due pending failed", "err", err)
	}
	for _, t := range due {
		s.taskSvc.ExecuteQuiz(t.TaskID)
	}

	// 2. Poll generating tasks (async quiz generation): ready -> sent, failed -> failed.
	//    Timeout: generating > 5min -> failed (LLM hung / main app crashed).
	generating, err := repo.ListGenerating(50)
	if err != nil {
		slog.Error("[SCHEDULER] list generating failed", "err", err)
	}
	for _, t := range generating {
		if time.Since(t.UpdatedAt) > 5*time.Minute {
			slog.Warn("[SCHEDULER] generating timeout (>5min), marking failed", "task_id", t.TaskID, "age", time.Since(t.UpdatedAt))
			_, _ = repo.ConditionalUpdate(t.TaskID, "generating", "failed", nil)
			continue
		}
		s.taskSvc.ProcessGenerating(t.TaskID)
	}

	// 3. Fire check_timeout for sent tasks whose deadline has passed.
	overdue, err := repo.ListOverdueSent(50)
	if err != nil {
		slog.Error("[SCHEDULER] list overdue sent failed", "err", err)
	}
	for _, t := range overdue {
		s.taskSvc.CheckTimeout(t.TaskID)
	}
}
