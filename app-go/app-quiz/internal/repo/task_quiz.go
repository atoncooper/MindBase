// MySQL data access for the scheduled-quiz business rows (quiz_task /
// quiz_task_answer) — port of app/repository/quiz_task_repository.py. app-quiz
// takes schema ownership from the Python backend; the scheduler state machine
// itself stays in the external app-task service.
package repo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ErrTaskQuizNotFound: the business row is missing or not owned by the caller.
var ErrTaskQuizNotFound = errors.New("task quiz not found")

// TaskQuizRow mirrors the quiz_task business row (app/models.py QuizTask).
type TaskQuizRow struct {
	ID                int64      `json:"id"`
	TaskID            string     `json:"task_id"`
	UID               int64      `json:"uid"`
	Prompt            string     `json:"prompt"`
	Difficulty        string     `json:"difficulty"`
	QuestionCount     int        `json:"question_count"`
	UserEmail         string     `json:"user_email"`
	CCEmails          *string    `json:"cc_emails"`
	IncompleteMessage *string    `json:"incomplete_message"`
	Deadline          *time.Time `json:"deadline"`
	Status            string     `json:"status"`
	OverdueEmailed    bool       `json:"overdue_emailed"`
	CreatedAt         *time.Time `json:"created_at"`
	UpdatedAt         *time.Time `json:"updated_at"`
}

const taskQuizColumns = "id, task_id, uid, prompt, difficulty, question_count, user_email, cc_emails, " +
	"incomplete_message, deadline, status, overdue_emailed, created_at, updated_at"

// GetTaskQuizByUID fetches an owned business row (not-owned == not-found).
func GetTaskQuizByUID(ctx context.Context, db *gorm.DB, taskID string, uid int64) (*TaskQuizRow, error) {
	var row TaskQuizRow
	err := db.WithContext(ctx).Raw(
		"SELECT "+taskQuizColumns+" FROM quiz_task WHERE task_id = ? AND uid = ?",
		taskID, uid,
	).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.ID == 0 {
		return nil, ErrTaskQuizNotFound
	}
	return &row, nil
}

// TaskQuizAnswerRow mirrors one quiz_task_answer row.
type TaskQuizAnswerRow struct {
	ID            int64      `json:"id"`
	TaskID        string     `json:"task_id"`
	UID           int64      `json:"uid"`
	QuestionIndex int        `json:"question_index"`
	Answer        string     `json:"answer"`
	IsCorrect     bool       `json:"is_correct"`
	SubmittedAt   *time.Time `json:"submitted_at"`
}

// ListTaskQuizAnswers returns the task's answers ordered by question index.
func ListTaskQuizAnswers(ctx context.Context, db *gorm.DB, taskID string) ([]TaskQuizAnswerRow, error) {
	var rows []TaskQuizAnswerRow
	err := db.WithContext(ctx).Raw(
		"SELECT id, task_id, uid, question_index, answer, is_correct, submitted_at "+
			"FROM quiz_task_answer WHERE task_id = ? ORDER BY question_index",
		taskID,
	).Scan(&rows).Error
	return rows, err
}

// TaskQuizJudgeResult is one judged answer (the judging rules live in the
// service layer; this is the persistence shape).
type TaskQuizJudgeResult struct {
	QuestionIndex int
	Answer        string
	IsCorrect     bool
}

// SaveTaskQuizAnswers inserts the judged answers and moves the business row to
// completed. The WHERE-status guard mirrors the Python repository (idempotent;
// an already-completed task keeps its answers).
func SaveTaskQuizAnswers(ctx context.Context, db *gorm.DB, taskID string, uid int64, results []TaskQuizJudgeResult) error {
	now := time.Now().UTC()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, r := range results {
			if err := tx.Exec(
				"INSERT INTO quiz_task_answer (task_id, uid, question_index, answer, is_correct, submitted_at) "+
					"VALUES (?, ?, ?, ?, ?, ?)",
				taskID, uid, r.QuestionIndex, r.Answer, r.IsCorrect, now,
			).Error; err != nil {
				return err
			}
		}
		return tx.Exec(
			"UPDATE quiz_task SET status = 'completed', updated_at = ? "+
				"WHERE task_id = ? AND status IN ('awaiting_answer','generating')",
			now, taskID,
		).Error
	})
}

// CreateTaskQuizRow inserts the generating business row (plain INSERT — the
// unique task_id makes a re-trigger of the same task a duplicate; callers
// treat that as idempotent). Parity with the Python repository insert.
func CreateTaskQuizRow(ctx context.Context, db *gorm.DB, taskID string, uid int64, prompt, difficulty string, questionCount int, userEmail string, ccEmails []string, incompleteMessage *string) error {
	now := time.Now().UTC()
	cc := "[]"
	if len(ccEmails) > 0 {
		if raw, err := json.Marshal(ccEmails); err == nil {
			cc = string(raw)
		}
	}
	return db.WithContext(ctx).Exec(
		"INSERT INTO quiz_task (task_id, uid, prompt, difficulty, question_count, user_email, cc_emails, incomplete_message, status, overdue_emailed, created_at, updated_at) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generating', 0, ?, ?)",
		taskID, uid, prompt, difficulty, questionCount, userEmail, cc, incompleteMessage, now, now,
	).Error
}

// MarkTaskQuizGenerated flips generating → awaiting_answer and arms the
// deadline (idempotent: only rows still generating are touched, mirroring
// the Python repository).
func MarkTaskQuizGenerated(ctx context.Context, db *gorm.DB, taskID string, deadline time.Time, questionCount int) error {
	return db.WithContext(ctx).Exec(
		"UPDATE quiz_task SET status = 'awaiting_answer', deadline = ?, question_count = ?, updated_at = ? "+
			"WHERE task_id = ? AND status = 'generating'",
		deadline, questionCount, time.Now().UTC(), taskID,
	).Error
}
