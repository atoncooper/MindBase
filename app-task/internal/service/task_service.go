package service

import (
	"fmt"
	"log/slog"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
)

// QuizGenerator abstracts the async quiz generation calls to the main app.
// *AppClient implements it in production; tests substitute a stub.
type QuizGenerator interface {
	RequestQuiz(taskID, prompt string, uid int64, difficulty string, questionCount int) (*QuizGenResponse, error)
	GetQuizStatus(taskID string) (*QuizGenResponse, error)
}

// TaskService orchestrates task lifecycle: register/execute/timeout.
// State machine: pending -> sent -> completed | overdue | failed.
// 答题提交/判题/入库由主 app 负责（POST /tasks/{id}/answer），app-task 不做业务。
type TaskService struct {
	appClient QuizGenerator
}

func NewTaskService(appClient QuizGenerator) *TaskService {
	return &TaskService{appClient: appClient}
}

// RegisterTask creates a pending task. The scheduler polls trigger_time and
// fires ExecuteQuiz when due - no explicit job registration needed.
func (s *TaskService) RegisterTask(uid int64, userEmail string, ccEmails []string, prompt string, difficulty string, questionCount int, triggerTime time.Time, incompleteMessage string) (string, error) {
	taskID := uuid.NewString()
	var incomplete *string
	if incompleteMessage != "" {
		incomplete = &incompleteMessage
	}
	if difficulty == "" {
		difficulty = "medium"
	}
	if questionCount < 1 || questionCount > 5 {
		questionCount = 1
	}
	task := &model.TaskQuizTask{
		TaskID:            taskID,
		UID:               uid,
		UserEmail:         userEmail,
		CCEmails:          toJSON(ccEmails),
		Prompt:            prompt,
		Difficulty:        difficulty,
		QuestionCount:     questionCount,
		IncompleteMessage: incomplete,
		TriggerTime:       triggerTime,
		Status:            "pending",
	}
	if err := repo.CreateTask(task); err != nil {
		return "", fmt.Errorf("create task: %w", err)
	}
	slog.Info("[TASK] registered", "task_id", taskID, "trigger", formatBeijing(triggerTime))
	return taskID, nil
}

// ExecuteQuiz requests async quiz generation from the main app. If the quiz is
// already ready (idempotent hit), finalizes immediately; otherwise moves the
// task to "generating" and lets the scheduler poll /status.
// Called by the scheduler when trigger_time passes. Idempotent (skips non-pending).
func (s *TaskService) ExecuteQuiz(taskID string) {
	task, err := repo.GetTaskByID(taskID)
	if err != nil {
		slog.Error("[TASK] execute: get task failed", "task_id", taskID, "err", err)
		return
	}
	if task == nil {
		slog.Warn("[TASK] execute: task not found", "task_id", taskID)
		return
	}
	if task.Status != "pending" {
		slog.Info("[TASK] execute: skip (idempotent)", "task_id", taskID, "status", task.Status)
		return
	}

	// Async: request quiz generation (returns immediately with generating/ready)
	resp, err := s.appClient.RequestQuiz(taskID, task.Prompt, task.UID, task.Difficulty, task.QuestionCount)
	if err != nil {
		slog.Error("[TASK] request quiz failed", "task_id", taskID, "err", err)
		_, _ = repo.ConditionalUpdate(taskID, "pending", "failed", nil)
		return
	}

	if resp.Status == "ready" && resp.Quiz != nil {
		// Idempotent hit: quiz already generated (e.g. retry after crash), finalize now
		s.finalizeQuiz(taskID, task, resp.Quiz, "pending")
		return
	}

	// status == generating -> move to generating, scheduler polls /status
	if _, err := repo.ConditionalUpdate(taskID, "pending", "generating", nil); err != nil {
		slog.Error("[TASK] mark generating failed", "task_id", taskID, "err", err)
		return
	}
	slog.Info("[TASK] quiz generating", "task_id", taskID)
}

// ProcessGenerating polls the quiz generation status for a task in "generating"
// state. Called by the scheduler tick. Moves to sent (ready) or failed.
func (s *TaskService) ProcessGenerating(taskID string) {
	task, err := repo.GetTaskByID(taskID)
	if err != nil || task == nil {
		return
	}
	if task.Status != "generating" {
		return
	}

	resp, err := s.appClient.GetQuizStatus(taskID)
	if err != nil {
		slog.Error("[TASK] poll quiz status failed", "task_id", taskID, "err", err)
		return
	}

	if resp.Status == "ready" && resp.Quiz != nil {
		s.finalizeQuiz(taskID, task, resp.Quiz, "generating")
		return
	}
	if resp.Status == "failed" {
		slog.Error("[TASK] quiz generation failed", "task_id", taskID, "error", resp.Error)
		_, _ = repo.ConditionalUpdate(taskID, "generating", "failed", nil)
		return
	}
	// status == generating -> skip, next tick polls again
}

// finalizeQuiz sends the quiz email + sets deadline + marks sent.
// Quiz content is NOT stored here: generation/入库归主 app（主 app 已把题目
// 写进共享 Mongo mind_base.task_quiz_questions），app-task 只读它用于详情，
// 判题也由主 app 负责（POST /tasks/{id}/answer）。
func (s *TaskService) finalizeQuiz(taskID string, task *model.TaskQuizTask, quiz *Quiz, fromStatus string) {
	if quiz == nil || len(quiz.Questions) == 0 {
		slog.Error("[TASK] finalizeQuiz: quiz empty, marking failed", "task_id", taskID)
		_, _ = repo.ConditionalUpdate(taskID, fromStatus, "failed", nil)
		return
	}
	// 任务级答题时限取第一题的建议值（deadline 是任务级的）
	limitSec := quiz.Questions[0].AnswerTimeLimitSeconds
	if limitSec <= 0 {
		limitSec = 1200
	}
	deadline := time.Now().UTC().Add(time.Duration(limitSec) * time.Second)

	cc := toStringSliceJSON(task.CCEmails)
	if err := EnqueueQuizEmail(taskID, task.UserEmail, cc, task.Prompt, quiz.Questions, formatBeijing(deadline)); err != nil {
		slog.Error("[TASK] enqueue quiz email failed, marking task failed", "task_id", taskID, "err", err)
		_, _ = repo.ConditionalUpdate(taskID, fromStatus, "failed", nil)
		return
	}

	if _, err := repo.ConditionalUpdate(taskID, fromStatus, "sent", map[string]any{"deadline": deadline}); err != nil {
		slog.Error("[TASK] mark sent failed", "task_id", taskID, "err", err)
		return
	}
	slog.Info("[TASK] executed", "task_id", taskID, "deadline", formatBeijing(deadline), "question_count", len(quiz.Questions))
}

// CheckTimeout marks overdue + enqueues incomplete email.
// Called by the scheduler when deadline passes. Idempotent (skips non-sent).
func (s *TaskService) CheckTimeout(taskID string) {
	task, err := repo.GetTaskByID(taskID)
	if err != nil || task == nil {
		return
	}
	if task.Status != "sent" {
		return
	}
	updated, err := repo.ConditionalUpdate(taskID, "sent", "overdue", nil)
	if err != nil || !updated {
		return
	}
	incomplete := ""
	if task.IncompleteMessage != nil {
		incomplete = *task.IncompleteMessage
	}
	cc := toStringSliceJSON(task.CCEmails)
	if err := EnqueueOverdueEmail(taskID, task.UserEmail, cc, incomplete, task.Prompt); err != nil {
		slog.Error("[TASK] enqueue overdue email failed", "task_id", taskID, "err", err)
	}
	slog.Info("[TASK] overdue", "task_id", taskID)
}
