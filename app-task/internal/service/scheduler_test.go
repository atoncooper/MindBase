package service

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupTestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.EmailMessage{}, &model.Script{}, &model.ScriptLog{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

// mustRegister creates a due (past trigger) task.
func mustRegister(t *testing.T, svc *TaskService, uid int64, taskType, payload, executorURL string, async bool, maxRetry int) string {
	t.Helper()
	taskID, err := svc.RegisterTask(uid, taskType, []byte(payload), executorURL, async, "", time.Now().UTC().Add(-time.Minute), maxRetry, 1)
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	return taskID
}

func mustHTTPExecutor(t *testing.T) *executor.HTTPExecutor {
	t.Helper()
	e, err := executor.NewHTTPExecutor(executor.HTTPOptions{Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func newSched(t *testing.T) *Scheduler {
	t.Helper()
	reg := executor.NewRegistry()
	reg.Register("http", mustHTTPExecutor(t).Handler())
	return NewScheduler(reg, 30)
}

// ── 同步执行：2xx → completed + 写 task_log ──────────────────────────

func TestScheduler_SyncSuccess(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{"a":1}`, srv.URL, false, 0)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" {
		t.Fatalf("status = %q, want completed", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "success" {
		t.Fatalf("logs = %+v, want 1 success entry", logs)
	}
}

// ── 异步：202 + async=true → running（等回调）───────────────────────

func TestScheduler_AsyncAccepted(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, srv.URL, true, 0)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "running" {
		t.Fatalf("status = %q, want running", task.Status)
	}
}

// ── 重试：500 + maxRetry=2 → retry → retry → failed ─────────────────

func TestScheduler_RetryPolicy(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, srv.URL, false, 2)

	newSched(t).tick()
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRetryAt == nil {
		t.Fatalf("after 1st failure: status=%q retry=%d, want pending/1", task.Status, task.RetryCount)
	}

	openRetry(t, taskID)
	newSched(t).tick()
	task, _ = repo.GetTaskByID(taskID)
	if task.Status != "pending" || task.RetryCount != 2 {
		t.Fatalf("after 2nd failure: status=%q retry=%d, want pending/2", task.Status, task.RetryCount)
	}

	openRetry(t, taskID)
	newSched(t).tick()
	task, _ = repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Fatalf("after retries exhausted: status=%q, want failed", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 3 {
		t.Fatalf("logs = %d, want 3 (retry,retry,failed)", len(logs))
	}
}

func openRetry(t *testing.T, taskID string) {
	t.Helper()
	past := time.Now().UTC().Add(-time.Minute)
	repo.ConditionalUpdate(taskID, "pending", "pending", map[string]any{"next_retry_at": past})
}

// ── 异步超时：running 超过 10m 未回调 → failed + timeout log ────────

func TestScheduler_RunningTimeout(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, "http://x", true, 0)
	repo.ConditionalUpdate(taskID, "pending", "running", nil)
	old := time.Now().UTC().Add(-20 * time.Minute)
	db.DB.Model(&model.Task{}).Where("task_id = ?", taskID).Update("updated_at", old)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Fatalf("status = %q, want failed (timeout)", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "timeout" {
		t.Fatalf("logs = %+v, want timeout entry", logs)
	}
}

// ── 回调：executor 完成报告 → running → completed（幂等）─────────────

func TestTaskService_CompleteTask(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, "http://x", true, 0)
	repo.ConditionalUpdate(taskID, "pending", "running", nil)

	status, err := svc.CompleteTask(taskID, "completed", `{"score":90}`, "")
	if err != nil || status != "completed" {
		t.Fatalf("CompleteTask = %q, %v", status, err)
	}
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" || task.LastResult == nil || *task.LastResult != `{"score":90}` {
		t.Fatalf("task = %+v", task)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "completed" {
		t.Fatalf("logs = %+v", logs)
	}

	// 幂等：重复回调返回当前状态，不产生新日志
	status, _ = svc.CompleteTask(taskID, "failed", "", "late")
	if status != "completed" {
		t.Fatalf("idempotent replay = %q, want completed", status)
	}
	logs, _ = repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 {
		t.Fatalf("logs after replay = %d, want 1", len(logs))
	}
}

// ── cron：周期任务在终态后克隆下一条 ────────────────────────────────

func TestScheduler_CronExtend(t *testing.T) {
	setBeijingLocal(t)
	setupTestDB(t)
	svc := NewTaskService()
	taskID, err := svc.RegisterTask(1, "http", nil, "http://x", false, "0 23 * * *", time.Now().UTC(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	repo.ConditionalUpdate(taskID, "pending", "completed", nil)

	newSched(t).tick()

	var next []model.Task
	db.DB.Where("cron_expr = ? AND status = ?", "0 23 * * *", "pending").Find(&next)
	if len(next) != 1 {
		t.Fatalf("next occurrences = %d, want 1", len(next))
	}
	if next[0].TaskID == taskID {
		t.Fatal("cloned task must have a new id")
	}
	orig, _ := repo.GetTaskByID(taskID)
	if orig.CronNextTaskID != next[0].TaskID {
		t.Fatalf("cron_next_task_id = %q, want %q", orig.CronNextTaskID, next[0].TaskID)
	}
}

func setBeijingLocal(t *testing.T) {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	old := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = old })
}
