package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/internal/service"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupRouterTestDB(t *testing.T) {
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

func newTestRouter(t *testing.T) (*service.TaskService, http.Handler) {
	t.Helper()
	setupRouterTestDB(t)
	taskSvc := service.NewTaskService()
	cfg := &config.Config{}
	cfg.Security.CORS.AllowOrigins = []string{"*"}
	cfg.Notification.WorkerIntervalSeconds = 30
	cfg.Notification.RetryMax = 5
	cfg.Notification.RetryBackoffBase = 2
	cfg.Email.From = "MindBase <onboarding@resend.dev>"
	cfg.WebUI.Enabled = true
	luaExec := executor.NewLuaExecutor(executor.LuaOptions{})
	emailSvc := service.NewEmailService(cfg)
	return taskSvc, New(taskSvc, emailSvc, luaExec, cfg)
}

// ── POST /tasks/register ───────────────────────────────────────────

func TestTasksRegister(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"uid":1,"task_type":"http","payload":{"to":"a@x.com"},"executor_url":"http://exec:9000","trigger_time":"2030-01-01T00:00:00Z","max_retry":3}`
	req := httptest.NewRequest("POST", "/tasks/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.TaskID == "" {
		t.Fatalf("resp = %s", w.Body.String())
	}
	task, _ := repo.GetTaskByID(resp.TaskID)
	if task == nil || task.ExecutorURL != "http://exec:9000" || task.MaxRetry != 3 || task.TaskType != "http" {
		t.Fatalf("task = %+v", task)
	}
}

func TestTasksRegister_RequiresTriggerOrCron(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"uid":1}`
	req := httptest.NewRequest("POST", "/tasks/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no trigger/cron)", w.Code)
	}
}

// ── GET /tasks/:id + /tasks ──────────────────────────────────────────

func TestTasksDetailAndList(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"uid":1,"trigger_time":"2030-01-01T00:00:00Z"}`
	req := httptest.NewRequest("POST", "/tasks/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var reg struct{ TaskID string `json:"task_id"` }
	json.Unmarshal(w.Body.Bytes(), &reg)

	// detail (owner)
	req2 := httptest.NewRequest("GET", "/tasks/"+reg.TaskID, nil)
	req2.Header.Set("X-Uid", "1")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body = %s", w2.Code, w2.Body.String())
	}

	// detail (not owner) → 403
	req3 := httptest.NewRequest("GET", "/tasks/"+reg.TaskID, nil)
	req3.Header.Set("X-Uid", "999")
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, req3)
	if w3.Code != http.StatusForbidden {
		t.Fatalf("detail status = %d, want 403", w3.Code)
	}

	// list
	req4 := httptest.NewRequest("GET", "/tasks", nil)
	req4.Header.Set("X-Uid", "1")
	w4 := httptest.NewRecorder()
	h.ServeHTTP(w4, req4)
	if w4.Code != http.StatusOK {
		t.Fatalf("list status = %d", w4.Code)
	}
}

// ── POST /internal/task/:id/complete（异步回调）─────────────────────

func TestTasksCompleteCallback(t *testing.T) {
	svc, h := newTestRouter(t)
	taskID, err := svc.RegisterTask(1, "http", []byte(`{}`), "http://exec", true, "", time.Now().UTC().Add(time.Minute), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	repo.ConditionalUpdate(taskID, "pending", "running", nil)

	body := `{"status":"completed","result":"{\"ok\":true}"}`
	req := httptest.NewRequest("POST", "/internal/task/"+taskID+"/complete", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body = %s", w.Code, w.Body.String())
	}
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" {
		t.Fatalf("task status = %q, want completed", task.Status)
	}
}

// ── POST /internal/email/send（executor 回调投递邮件）─────────────────

func TestEmailSendEndpoint(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"to":["a@x.com"],"cc":["c@x.com"],"subject":"出题提醒","html":"<p>hi</p>","reference_id":"task-1"}`
	req := httptest.NewRequest("POST", "/internal/email/send", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		EmailID string `json:"email_id"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.EmailID == "" || resp.Status != "queued" {
		t.Fatalf("resp = %s", w.Body.String())
	}

	// 缺 to → 400
	bad := `{"subject":"s","html":"<p>x</p>"}`
	req2 := httptest.NewRequest("POST", "/internal/email/send", bytes.NewBufferString(bad))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (missing to)", w2.Code)
	}
}
