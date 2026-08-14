package service

import (
	"testing"
	"time"

	"app-task/internal/repo"
)

// registerDueTask creates a pending task whose trigger_time has already passed.
func registerDueTask(t *testing.T, svc *TaskService, uid int64, prompt string) string {
	t.Helper()
	taskID, err := svc.RegisterTask(uid, "u@x.com", nil, prompt, "medium", 1, time.Now().UTC().Add(-time.Minute), "")
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	return taskID
}

// ── tick(): DB polling logic (synchronous, no goroutine) ─────────

func TestScheduler_TickExecutesDuePending(t *testing.T) {
	setupTestDB(t)
	// ExecuteQuiz -> RequestQuiz returns ready -> finalize -> sent
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID := registerDueTask(t, svc, 1, "p1")

	sched := NewScheduler(svc, 30)
	sched.tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "sent" {
		t.Errorf("status = %q, want sent (tick fires due pending)", task.Status)
	}
}

func TestScheduler_TickSkipsFutureTask(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "p", "medium", 1, time.Now().UTC().Add(time.Hour), "")

	sched := NewScheduler(svc, 30)
	sched.tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "pending" {
		t.Errorf("status = %q, want pending (future task not due)", task.Status)
	}
}

func TestScheduler_TickChecksOverdueSent(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil) // CheckTimeout doesn't use appClient
	taskID := registerDueTask(t, svc, 1, "p")
	pastDeadline := time.Now().UTC().Add(-time.Minute)
	repo.ConditionalUpdate(taskID, "pending", "sent", map[string]any{"deadline": pastDeadline})

	sched := NewScheduler(svc, 30)
	sched.tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "overdue" {
		t.Errorf("status = %q, want overdue (tick fires CheckTimeout)", task.Status)
	}
}

// ── Restart recovery: catch up on overdue tasks after restart ────

func TestScheduler_RestartRecovery(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	id1 := registerDueTask(t, svc, 1, "p1")
	id2 := registerDueTask(t, svc, 2, "p2")

	sched := NewScheduler(svc, 30)
	sched.tick()

	for _, id := range []string{id1, id2} {
		task, _ := repo.GetTaskByID(id)
		if task == nil {
			t.Errorf("task %s not found", id)
			continue
		}
		if task.Status != "sent" {
			t.Errorf("task %s status = %q, want sent (recovered after restart)", id[:8], task.Status)
		}
	}
}

func TestScheduler_StartFiresImmediatelyOnRestart(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID := registerDueTask(t, svc, 1, "p")

	sched := NewScheduler(svc, 1)
	sched.Start()
	defer sched.Stop()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		task, _ := repo.GetTaskByID(taskID)
		if task != nil && task.Status == "sent" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("task not executed within 1s of Start() - restart catch-up failed")
}
