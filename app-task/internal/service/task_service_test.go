package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupTestDB opens an in-memory SQLite GORM DB and wires it as the global
// db.DB so repo package-level functions (CreateTask/GetTaskByID/ConditionalUpdate/...)
// operate against it. Tables are auto-migrated from the GORM models.
//
// SQLite is used instead of MySQL so tests run hermetically with no external
// service. GORM abstracts the SQL dialect, so ConditionalUpdate (WHERE status=?)
// and the state-machine semantics exercise the same code path as production.
func setupTestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	// SQLite :memory: is per-connection; force a single connection so the
	// scheduler goroutine sees the same tables the test set up on the main
	// connection. Without this, the scheduler tick runs on a different
	// connection that has no tables -> "no such table: task_quiz_task".
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.TaskQuizTask{}, &model.TaskQuizAnswer{}, &model.TaskQuizNotification{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
	// Stub Mongo InsertQuiz: finalizeQuiz stores quiz to app-task Mongo; tests
	// don't have real Mongo, so no-op (router_test.go does the same).
	repo.InsertQuiz = func(context.Context, map[string]any) error { return nil }
}

// ── judge: pure function, no DB ──────────────────────────────────

func TestJudge(t *testing.T) {
	tests := []struct {
		name   string
		quiz   map[string]any
		answer string
		want   bool
	}{
		// choice / fill_blank: exact match after TrimSpace (case-sensitive)
		{"choice correct", map[string]any{"question_type": "choice", "answer": "A"}, "A", true},
		{"choice trim whitespace", map[string]any{"question_type": "choice", "answer": "A"}, "  A  ", true},
		{"choice wrong option", map[string]any{"question_type": "choice", "answer": "A"}, "B", false},
		{"choice case sensitive", map[string]any{"question_type": "choice", "answer": "A"}, "a", false},
		{"fill_blank correct", map[string]any{"question_type": "fill_blank", "answer": "42"}, "42", true},
		{"fill_blank trim", map[string]any{"question_type": "fill_blank", "answer": "42"}, " 42 ", true},
		{"fill_blank wrong", map[string]any{"question_type": "fill_blank", "answer": "42"}, "43", false},
		// short_answer: case-insensitive contains
		{"short_answer contains", map[string]any{"question_type": "short_answer", "answer": "牛顿"}, "牛顿发现万有引力", true},
		{"short_answer case insensitive", map[string]any{"question_type": "short_answer", "answer": "Newton"}, "isaac newton was here", true},
		{"short_answer not contains", map[string]any{"question_type": "short_answer", "answer": "牛顿"}, "爱因斯坦", false},
		// edge cases
		{"nil quiz", nil, "A", false},
		{"empty answer", map[string]any{"question_type": "choice", "answer": "A"}, "", false},
		{"empty correct", map[string]any{"question_type": "choice", "answer": ""}, "A", false},
		{"unknown type falls back to exact", map[string]any{"question_type": "unknown", "answer": "X"}, "X", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := judge(tt.quiz, tt.answer); got != tt.want {
				t.Errorf("judge() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ── RegisterTask: persists task with difficulty + state ──────────

func TestRegisterTask(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil) // appClient nil — RegisterTask never calls it

	trigger := time.Now().UTC().Add(time.Hour)
	taskID, err := svc.RegisterTask(1, "u@x.com", []string{"c@x.com"}, "数学1填空题", "hard", trigger, "加油")
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	if taskID == "" {
		t.Fatal("empty taskID")
	}

	task, err := repo.GetTaskByID(taskID)
	if err != nil {
		t.Fatalf("GetTaskByID: %v", err)
	}
	if task == nil {
		t.Fatal("task not persisted")
	}
	if task.UID != 1 {
		t.Errorf("UID = %d, want 1", task.UID)
	}
	if task.Prompt != "数学1填空题" {
		t.Errorf("Prompt = %q, want 数学1填空题", task.Prompt)
	}
	if task.Difficulty != "hard" {
		t.Errorf("Difficulty = %q, want hard", task.Difficulty)
	}
	if task.Status != "pending" {
		t.Errorf("Status = %q, want pending", task.Status)
	}
	if task.UserEmail != "u@x.com" {
		t.Errorf("UserEmail = %q, want u@x.com", task.UserEmail)
	}
	if task.IncompleteMessage == nil || *task.IncompleteMessage != "加油" {
		t.Errorf("IncompleteMessage = %v, want 加油", task.IncompleteMessage)
	}
}

func TestRegisterTask_DefaultDifficulty(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	// empty difficulty -> should default to "medium"
	taskID, err := svc.RegisterTask(1, "u@x.com", nil, "prompt", "", time.Now().UTC().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	task, _ := repo.GetTaskByID(taskID)
	if task == nil {
		t.Fatal("task not persisted")
	}
	if task.Difficulty != "medium" {
		t.Errorf("default Difficulty = %q, want medium", task.Difficulty)
	}
}

func TestRegisterTask_EmptyIncomplete(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(time.Hour), "")
	task, _ := repo.GetTaskByID(taskID)
	if task == nil {
		t.Fatal("task not persisted")
	}
	if task.IncompleteMessage != nil {
		t.Errorf("IncompleteMessage = %v, want nil", task.IncompleteMessage)
	}
}

// ── SubmitAnswer: ownership + idempotency (no Mongo needed) ──────

func TestSubmitAnswer_TaskNotFound(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	_, err := svc.SubmitAnswer("nonexistent-task", 1, "A")
	if err != ErrNotFound {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestSubmitAnswer_NotOwner(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(time.Hour), "")
	// uid 999 != owner 1
	_, err := svc.SubmitAnswer(taskID, 999, "A")
	if err != ErrForbidden {
		t.Errorf("want ErrForbidden, got %v", err)
	}
}

func TestSubmitAnswer_AlreadyAnswered(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(time.Hour), "")
	// simulate: task already sent + an answer row already exists
	if ok, _ := repo.ConditionalUpdate(taskID, "pending", "sent", nil); !ok {
		t.Fatal("ConditionalUpdate pending->sent failed")
	}
	if err := repo.CreateAnswer(&model.TaskQuizAnswer{
		TaskID: taskID, UID: 1, Answer: "A", IsCorrect: true,
	}); err != nil {
		t.Fatalf("CreateAnswer: %v", err)
	}

	// second submit should short-circuit and return the existing answer
	res, err := svc.SubmitAnswer(taskID, 1, "B")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	if res["is_correct"] != true {
		t.Errorf("want existing is_correct=true, got %v", res["is_correct"])
	}
}

// ── State machine: ConditionalUpdate semantics ───────────────────

func TestConditionalUpdate_GuardsStateTransition(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(time.Hour), "")

	// pending -> sent: ok
	ok, err := repo.ConditionalUpdate(taskID, "pending", "sent", nil)
	if err != nil || !ok {
		t.Fatalf("pending->sent: ok=%v err=%v", ok, err)
	}
	// pending -> sent again: should fail (already sent, race loser)
	ok, _ = repo.ConditionalUpdate(taskID, "pending", "sent", nil)
	if ok {
		t.Error("second pending->sent should be blocked (status no longer pending)")
	}
	// sent -> completed: ok
	ok, _ = repo.ConditionalUpdate(taskID, "sent", "completed", nil)
	if !ok {
		t.Error("sent->completed should succeed")
	}
	// sent -> overdue: should fail (already completed)
	ok, _ = repo.ConditionalUpdate(taskID, "sent", "overdue", nil)
	if ok {
		t.Error("sent->overdue after completed should be blocked")
	}
}

// ── SubmitAnswer full path: judge + CreateAnswer + state transition ──
// These stub repo.GetQuizByTaskID (Mongo) so the whole chain runs against
// SQLite for the MySQL side, exercising judge + CreateAnswer + ConditionalUpdate.

// withQuiz stubs repo.GetQuizByTaskID to return the given quiz doc, and
// restores the original on test cleanup.
func withQuiz(t *testing.T, quiz map[string]any) {
	t.Helper()
	orig := repo.GetQuizByTaskID
	repo.GetQuizByTaskID = func(ctx context.Context, _ string) (map[string]any, error) {
		return quiz, nil
	}
	t.Cleanup(func() { repo.GetQuizByTaskID = orig })
}

// registerSentTask creates a task and advances it to the "sent" state,
// ready for answering.
func registerSentTask(t *testing.T, svc *TaskService, uid int64) string {
	t.Helper()
	taskID, err := svc.RegisterTask(uid, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(time.Hour), "")
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	if ok, _ := repo.ConditionalUpdate(taskID, "pending", "sent", nil); !ok {
		t.Fatal("ConditionalUpdate pending->sent failed")
	}
	return taskID
}

func TestSubmitAnswer_CorrectChoice(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID := registerSentTask(t, svc, 1)
	withQuiz(t, map[string]any{"question_type": "choice", "answer": "A", "options": []any{"A", "B", "C"}})

	res, err := svc.SubmitAnswer(taskID, 1, "A")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	if res["is_correct"] != true {
		t.Errorf("is_correct = %v, want true", res["is_correct"])
	}
	if res["status"] != "completed" {
		t.Errorf("status = %v, want completed", res["status"])
	}
	// answer persisted with is_correct=true
	ans, _ := repo.GetAnswerByTaskID(taskID)
	if ans == nil || !ans.IsCorrect {
		t.Errorf("answer not persisted / is_correct wrong: %+v", ans)
	}
	// task moved to completed
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" {
		t.Errorf("task status = %q, want completed", task.Status)
	}
}

func TestSubmitAnswer_WrongChoice(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID := registerSentTask(t, svc, 1)
	withQuiz(t, map[string]any{"question_type": "choice", "answer": "A", "options": []any{"A", "B", "C"}})

	res, err := svc.SubmitAnswer(taskID, 1, "B")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	if res["is_correct"] != false {
		t.Errorf("is_correct = %v, want false", res["is_correct"])
	}
	// wrong answer still completes the task (status -> completed)
	if res["status"] != "completed" {
		t.Errorf("status = %v, want completed (wrong answer still completes)", res["status"])
	}
}

func TestSubmitAnswer_ShortAnswerContains(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID := registerSentTask(t, svc, 1)
	withQuiz(t, map[string]any{"question_type": "short_answer", "answer": "牛顿"})

	res, err := svc.SubmitAnswer(taskID, 1, "牛顿发现了万有引力定律")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	if res["is_correct"] != true {
		t.Errorf("is_correct = %v, want true (short_answer uses contains match)", res["is_correct"])
	}
}

func TestSubmitAnswer_QuizNotFound(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID := registerSentTask(t, svc, 1)
	// quiz doc missing (e.g. ExecuteQuiz crashed before InsertQuiz)
	withQuiz(t, nil)

	res, err := svc.SubmitAnswer(taskID, 1, "A")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	// nil quiz -> judge returns false; answer still recorded, task still completes
	if res["is_correct"] != false {
		t.Errorf("is_correct = %v, want false (nil quiz -> judge false)", res["is_correct"])
	}
}

func TestSubmitAnswer_RaceLostToTimeout(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID := registerSentTask(t, svc, 1)
	withQuiz(t, map[string]any{"question_type": "choice", "answer": "A"})

	// simulate: timeout already moved the task to "overdue" before this submit
	if ok, _ := repo.ConditionalUpdate(taskID, "sent", "overdue", nil); !ok {
		t.Fatal("ConditionalUpdate sent->overdue failed")
	}

	res, err := svc.SubmitAnswer(taskID, 1, "A")
	if err != nil {
		t.Fatalf("SubmitAnswer: %v", err)
	}
	// answer is correct and persisted...
	if res["is_correct"] != true {
		t.Errorf("is_correct = %v, want true", res["is_correct"])
	}
	// ...but status is NOT "completed" (ConditionalUpdate sent->completed lost
	// the race to the timeout's sent->overdue)
	if res["status"] == "completed" {
		t.Errorf("status = completed, but race should have been lost to overdue")
	}
}

// ── ExecuteQuiz: generate + store + notify + state transition ──

type mockAppClient struct {
	requestStatus string // generating | ready
	requestQuiz   *Quiz
	requestErr    error
	statusResp    *QuizGenResponse
	statusErr     error
}

func (m *mockAppClient) RequestQuiz(taskID, prompt string, uid int64, difficulty string) (*QuizGenResponse, error) {
	if m.requestErr != nil {
		return nil, m.requestErr
	}
	return &QuizGenResponse{Status: m.requestStatus, Quiz: m.requestQuiz}, nil
}

func (m *mockAppClient) GetQuizStatus(taskID string) (*QuizGenResponse, error) {
	if m.statusErr != nil {
		return nil, m.statusErr
	}
	if m.statusResp != nil {
		return m.statusResp, nil
	}
	return &QuizGenResponse{Status: "generating"}, nil
}

// testQuiz is a ready Quiz returned by mockAppClient when requestStatus=ready.
var testQuiz = &Quiz{
	Question:               "1+1=?",
	QuestionType:           "choice",
	Options:                []string{"1", "2", "3"},
	Answer:                 "2",
	Difficulty:             "easy",
	AnswerTimeLimitSeconds: 600,
}

func TestExecuteQuiz_Generating(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "generating"})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Minute), "")

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "generating" {
		t.Errorf("status = %q, want generating", task.Status)
	}
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 0 {
		t.Errorf("notifications = %d, want 0 (still generating)", len(notifs))
	}
}

func TestExecuteQuiz_Ready(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID, _ := svc.RegisterTask(1, "u@x.com", []string{"c@x.com"}, "prompt", "easy", time.Now().UTC().Add(-time.Minute), "")

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "sent" {
		t.Errorf("status = %q, want sent (ready -> finalize)", task.Status)
	}
	if task.Deadline == nil {
		t.Error("deadline not set")
	}
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 1 || notifs[0].Type != "quiz_email" {
		t.Errorf("notifications = %v, want 1 quiz_email", notifs)
	}
}

func TestExecuteQuiz_RequestFails(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestErr: errors.New("connection refused")})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Minute), "")

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Errorf("status = %q, want failed", task.Status)
	}
}

func TestExecuteQuiz_SkipIfNotPending(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Minute), "")
	repo.ConditionalUpdate(taskID, "pending", "sent", nil)

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "sent" {
		t.Errorf("status = %q, want sent (skipped)", task.Status)
	}
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 0 {
		t.Errorf("notifications = %d, want 0 (skipped)", len(notifs))
	}
}

func TestExecuteQuiz_TaskNotFound(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{})
	svc.ExecuteQuiz("nonexistent-task") // should not panic
}

// ── ProcessGenerating: poll /status, finalize or fail ────────────

func TestProcessGenerating_Ready(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{
		statusResp: &QuizGenResponse{Status: "ready", Quiz: testQuiz},
	})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")
	repo.ConditionalUpdate(taskID, "pending", "generating", nil)

	svc.ProcessGenerating(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "sent" {
		t.Errorf("status = %q, want sent (ready -> finalize)", task.Status)
	}
}

func TestProcessGenerating_Failed(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{
		statusResp: &QuizGenResponse{Status: "failed", Error: "LLM error"},
	})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")
	repo.ConditionalUpdate(taskID, "pending", "generating", nil)

	svc.ProcessGenerating(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Errorf("status = %q, want failed", task.Status)
	}
}

func TestProcessGenerating_StillGenerating(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{statusResp: &QuizGenResponse{Status: "generating"}})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")
	repo.ConditionalUpdate(taskID, "pending", "generating", nil)

	svc.ProcessGenerating(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "generating" {
		t.Errorf("status = %q, want generating (still polling)", task.Status)
	}
}

func TestProcessGenerating_SkipIfNotGenerating(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(&mockAppClient{statusResp: &QuizGenResponse{Status: "ready", Quiz: testQuiz}})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")
	repo.ConditionalUpdate(taskID, "pending", "sent", nil)

	svc.ProcessGenerating(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "sent" {
		t.Errorf("status = %q, want sent (skipped, not generating)", task.Status)
	}
}

// ── CheckTimeout: overdue transition + incomplete email ──
// CheckTimeout uses neither appClient nor InsertQuiz, so no mocks needed
// beyond setupTestDB (EnqueueOverdueEmail runs for real against SQLite +
// embedded template, exercising the notification enqueue).

func TestCheckTimeout_Success(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil) // CheckTimeout never calls appClient
	taskID, _ := svc.RegisterTask(1, "u@x.com", []string{"c@x.com"}, "数学1", "medium", time.Now().UTC().Add(-time.Hour), "加油快做")
	// advance to sent (quiz delivered, waiting for answer)
	repo.ConditionalUpdate(taskID, "pending", "sent", nil)

	svc.CheckTimeout(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "overdue" {
		t.Errorf("status = %q, want overdue", task.Status)
	}
	// overdue email enqueued
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 1 {
		t.Errorf("notifications = %d, want 1", len(notifs))
	}
	if len(notifs) > 0 && notifs[0].Type != "overdue_email" {
		t.Errorf("notification type = %q, want overdue_email", notifs[0].Type)
	}
}

func TestCheckTimeout_SkipIfNotSent(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	// task still pending (not yet sent) -> CheckTimeout should skip
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")

	svc.CheckTimeout(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "pending" {
		t.Errorf("status = %q, want pending (skipped)", task.Status)
	}
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 0 {
		t.Errorf("notifications = %d, want 0 (skipped)", len(notifs))
	}
}

func TestCheckTimeout_TaskNotFound(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	// should not panic, just return
	svc.CheckTimeout("nonexistent-task")
}

func TestCheckTimeout_RaceLostToAnswer(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService(nil)
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Hour), "")
	// user answered just before timeout: sent -> completed
	repo.ConditionalUpdate(taskID, "pending", "sent", nil)
	repo.ConditionalUpdate(taskID, "sent", "completed", nil)

	svc.CheckTimeout(taskID) // sent->overdue should lose the race

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" {
		t.Errorf("status = %q, want completed (race lost, no overwrite)", task.Status)
	}
	// no overdue email (race lost)
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 0 {
		t.Errorf("notifications = %d, want 0 (race lost, no overdue email)", len(notifs))
	}
}

// ── finalizeQuiz: store/enqueue failures must NOT silently advance to sent ──

func TestFinalizeQuiz_StoreQuizFails(t *testing.T) {
	setupTestDB(t)
	// stub InsertQuiz to fail (e.g. Mongo down) -> finalizeQuiz must abort
	orig := repo.InsertQuiz
	repo.InsertQuiz = func(context.Context, map[string]any) error {
		return errors.New("mongo connection refused")
	}
	t.Cleanup(func() { repo.InsertQuiz = orig })

	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Minute), "")

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Errorf("status = %q, want failed (store quiz failed must not advance to sent)", task.Status)
	}
	var notifs []model.TaskQuizNotification
	db.DB.Find(&notifs)
	if len(notifs) != 0 {
		t.Errorf("notifications = %d, want 0 (finalize aborted before enqueue)", len(notifs))
	}
}

func TestFinalizeQuiz_EnqueueFails(t *testing.T) {
	setupTestDB(t)
	// stub CreateNotification to fail -> EnqueueQuizEmail fails -> must abort
	orig := repo.CreateNotification
	repo.CreateNotification = func(*model.TaskQuizNotification) error {
		return errors.New("mysql connection refused")
	}
	t.Cleanup(func() { repo.CreateNotification = orig })

	svc := NewTaskService(&mockAppClient{requestStatus: "ready", requestQuiz: testQuiz})
	taskID, _ := svc.RegisterTask(1, "u@x.com", nil, "prompt", "medium", time.Now().UTC().Add(-time.Minute), "")

	svc.ExecuteQuiz(taskID)

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Errorf("status = %q, want failed (enqueue email failed must not advance to sent)", task.Status)
	}
}
