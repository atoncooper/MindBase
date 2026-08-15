package router

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/internal/service"

	"github.com/glebarez/sqlite"
	"go.mongodb.org/mongo-driver/bson/primitive"
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
	if err := gdb.AutoMigrate(&model.TaskQuizTask{}, &model.TaskQuizAnswer{}, &model.TaskQuizNotification{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

// stubQuizGen satisfies service.QuizGenerator (async) without HTTP.
type stubQuizGen struct {
	requestStatus string
	requestQuiz   *service.Quiz
}

func (s *stubQuizGen) RequestQuiz(taskID, prompt string, uid int64, difficulty string, questionCount int) (*service.QuizGenResponse, error) {
	return &service.QuizGenResponse{Status: s.requestStatus, Quiz: s.requestQuiz}, nil
}

func (s *stubQuizGen) GetQuizStatus(taskID string) (*service.QuizGenResponse, error) {
	return &service.QuizGenResponse{Status: s.requestStatus, Quiz: s.requestQuiz}, nil
}

func newTestRouter(t *testing.T) (*service.TaskService, http.Handler) {
	t.Helper()
	setupRouterTestDB(t)
	svc := service.NewTaskService(&stubQuizGen{
		requestStatus: "ready",
		requestQuiz: &service.Quiz{
			Questions: []service.QuizQuestion{
				{Question: "q", QuestionType: "choice", Answer: "A",
					AnswerTimeLimitSeconds: 600, Difficulty: "easy"},
			},
		},
	})
	cfg := &config.Config{}
	cfg.Security.CORS.AllowOrigins = []string{"*"}
	return svc, New(svc, cfg)
}

// ── POST /tasks/register ─────────────────────────────────────────

func TestRegisterHandler(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"uid":1,"user_email":"u@x.com","prompt":"p","difficulty":"hard","trigger_time":"2026-08-06T12:00:00Z"}`
	req := httptest.NewRequest("POST", "/tasks/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "pending" {
		t.Errorf("status = %v, want pending", resp["status"])
	}
	if resp["task_id"] == nil {
		t.Error("task_id missing")
	}
}

func TestRegisterHandler_InvalidBody(t *testing.T) {
	_, h := newTestRouter(t)
	body := `{"uid":1}` // missing prompt + trigger_time
	req := httptest.NewRequest("POST", "/tasks/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Errorf("status = %d, want 400 (missing required fields)", w.Code)
	}
}

// ── GET /tasks ───────────────────────────────────────────────────

func TestListHandler(t *testing.T) {
	svc, h := newTestRouter(t)
	svc.RegisterTask(1, "u@x.com", nil, "p1", "medium", 1, time.Now().UTC().Add(time.Hour), "")
	svc.RegisterTask(1, "u@x.com", nil, "p2", "hard", 1, time.Now().UTC().Add(time.Hour), "")

	req := httptest.NewRequest("GET", "/tasks", nil)
	req.Header.Set("X-Uid", "1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Tasks []map[string]any `json:"tasks"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Tasks) != 2 {
		t.Errorf("tasks = %d, want 2", len(resp.Tasks))
	}
}

func TestListHandler_NoXUid(t *testing.T) {
	_, h := newTestRouter(t)
	req := httptest.NewRequest("GET", "/tasks", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 (no X-Uid)", w.Code)
	}
}

// ── GET /tasks/:id ───────────────────────────────────────────────

func TestDetailHandler(t *testing.T) {
	svc, h := newTestRouter(t)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "p", "medium", 1, time.Now().UTC().Add(time.Hour), "")
	repo.GetQuizByTaskID = func(ctx context.Context, _ string) (map[string]any, error) {
		return map[string]any{"question": "q", "answer": "A"}, nil
	}

	req := httptest.NewRequest("GET", "/tasks/"+taskID, nil)
	req.Header.Set("X-Uid", "1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["task_id"] != taskID {
		t.Errorf("task_id = %v, want %s", resp["task_id"], taskID)
	}
}

func TestDetailHandler_NotOwner(t *testing.T) {
	svc, h := newTestRouter(t)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "p", "medium", 1, time.Now().UTC().Add(time.Hour), "")

	req := httptest.NewRequest("GET", "/tasks/"+taskID, nil)
	req.Header.Set("X-Uid", "999") // not owner
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 403 {
		t.Errorf("status = %d, want 403 (not owner)", w.Code)
	}
}

func TestDetailHandler_NotFound(t *testing.T) {
	_, h := newTestRouter(t)
	req := httptest.NewRequest("GET", "/tasks/nonexistent", nil)
	req.Header.Set("X-Uid", "1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// ── normalizeQuizQuestions: bson primitive.A vs []any vs legacy flat ──

func TestNormalizeQuizQuestions(t *testing.T) {
	// 新文档：mongo-driver 解码数组得到 primitive.A（命名 []any），
	// 不能直接 `.([]any)` 断言——必须兼容（回归：多题出题后前端无内容）
	primitiveDoc := map[string]any{
		"questions": primitive.A{
			primitive.M{"question": "q1", "answer": "A"},
			primitive.M{"question": "q2", "answer": "B"},
		},
	}
	qs := normalizeQuizQuestions(primitiveDoc)
	if len(qs) != 2 {
		t.Fatalf("primitive.A questions = %d, want 2", len(qs))
	}

	// 新文档但恰好是 []any（例如测试中手工构造）
	plainDoc := map[string]any{
		"questions": []any{map[string]any{"question": "q1", "answer": "A"}},
	}
	if qs := normalizeQuizQuestions(plainDoc); len(qs) != 1 {
		t.Fatalf("[]any questions = %d, want 1", len(qs))
	}

	// 旧单题平铺文档（兼容）
	legacyDoc := map[string]any{
		"question": "q", "question_type": "choice",
		"options": []any{"A", "B"}, "answer": "A",
	}
	if qs := normalizeQuizQuestions(legacyDoc); len(qs) != 1 || qs[0].(map[string]any)["question"] != "q" {
		t.Fatalf("legacy doc normalized wrong: %+v", qs)
	}

	// 空/无题目
	if qs := normalizeQuizQuestions(nil); len(qs) != 0 {
		t.Fatalf("nil doc = %d, want 0", len(qs))
	}
	if qs := normalizeQuizQuestions(map[string]any{"task_id": "t"}); len(qs) != 0 {
		t.Fatalf("doc without questions = %d, want 0", len(qs))
	}
}
