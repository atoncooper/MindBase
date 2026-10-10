// Scheduled-quiz business service (detail + answer judging) — port of
// app/routers/task_answer.py + app/services/task_quiz_answer.py. Judging is
// deterministic (no LLM), so it lives here next to the storage it reads.
//
// Judging rules (Python parity):
//   - choice: both the stored correct answer and the submitted answer are
//     resolved to an option letter (bare letter / full option text / label-less
//     text), then compared — avoids "correct answer judged wrong".
//   - fill_blank: trimmed exact compare.
//   - short_answer: case-insensitive containment (correct ⊂ given).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"app-quiz/internal/repo"

	"github.com/go-sql-driver/mysql"
)

// TaskQuizAnswerInput is one submitted answer (index 0-based).
type TaskQuizAnswerInput struct {
	QuestionIndex int
	Answer        string
}

// TaskQuizDetail assembles the business detail (task row + questions + answers).
func (s *Store) TaskQuizDetail(ctx context.Context, uid int64, taskID string) (map[string]interface{}, *APIError) {
	row, err := repo.GetTaskQuizByUID(ctx, s.DB, taskID, uid)
	if err != nil {
		if errors.Is(err, repo.ErrTaskQuizNotFound) {
			return nil, apiErr(404, "task not found")
		}
		return nil, apiErr(500, "查询失败，请稍后重试")
	}
	questions := repo.GetTaskQuizQuestions(ctx, s.Mongo, taskID)
	if questions == nil {
		questions = []map[string]interface{}{}
	}
	answers, err := repo.ListTaskQuizAnswers(ctx, s.DB, taskID)
	if err != nil {
		return nil, apiErr(500, "查询失败，请稍后重试")
	}
	answerView := make([]map[string]interface{}, 0, len(answers))
	for _, a := range answers {
		answerView = append(answerView, map[string]interface{}{
			"question_index": a.QuestionIndex,
			"answer":         a.Answer,
			"is_correct":     a.IsCorrect,
			"submitted_at":   pyISO(a.SubmittedAt),
		})
	}
	return map[string]interface{}{
		"task_id":    row.TaskID,
		"prompt":     row.Prompt,
		"difficulty": row.Difficulty,
		"status":     row.Status,
		"deadline":   pyISO(row.Deadline),
		"cc_emails":  parseCCEmails(row.CCEmails),
		"quiz":       map[string]interface{}{"questions": questions},
		"answers":    answerView,
	}, nil
}

// SubmitTaskQuizAnswer judges every answer, persists the results and moves the
// business row to completed. Ownership is enforced (not-owned == 404).
func (s *Store) SubmitTaskQuizAnswer(ctx context.Context, uid int64, taskID string, answers []TaskQuizAnswerInput) (map[string]interface{}, *APIError) {
	questions := repo.GetTaskQuizQuestions(ctx, s.Mongo, taskID)

	results := make([]repo.TaskQuizJudgeResult, 0, len(answers))
	allCorrect := len(answers) > 0
	for _, a := range answers {
		var q map[string]interface{}
		if a.QuestionIndex >= 0 && a.QuestionIndex < len(questions) {
			q = questions[a.QuestionIndex]
		}
		given := strings.TrimSpace(a.Answer)
		correct := judgeTaskQuizAnswer(q, given)
		if !correct {
			allCorrect = false
		}
		results = append(results, repo.TaskQuizJudgeResult{
			QuestionIndex: a.QuestionIndex,
			Answer:        given,
			IsCorrect:     correct,
		})
	}

	if _, err := repo.GetTaskQuizByUID(ctx, s.DB, taskID, uid); err != nil {
		if errors.Is(err, repo.ErrTaskQuizNotFound) {
			return nil, apiErr(404, "task not found")
		}
		return nil, apiErr(500, "查询失败，请稍后重试")
	}
	if err := repo.SaveTaskQuizAnswers(ctx, s.DB, taskID, uid, results); err != nil {
		return nil, apiErr(500, "保存失败，请稍后重试")
	}

	view := make([]map[string]interface{}, 0, len(results))
	for _, r := range results {
		view = append(view, map[string]interface{}{
			"question_index": r.QuestionIndex,
			"answer":         r.Answer,
			"is_correct":     r.IsCorrect,
		})
	}
	return map[string]interface{}{
		"status":     "completed",
		"is_correct": allCorrect,
		"results":    view,
	}, nil
}

// ── judging (pure; unit-tested) ──────────────────────────────────────

// judgeTaskQuizAnswer answers whether one submitted answer is correct.
func judgeTaskQuizAnswer(quiz map[string]interface{}, userAnswer string) bool {
	if quiz == nil {
		return false
	}
	correct := strings.TrimSpace(stringValue(quiz["answer"]))
	given := strings.TrimSpace(userAnswer)
	if correct == "" {
		return false
	}
	if stringValue(quiz["question_type"]) == "short_answer" {
		return strings.Contains(strings.ToLower(given), strings.ToLower(correct))
	}
	options := stringSlice(quiz["options"])
	if len(options) > 0 {
		cLetter := choiceLetter(options, correct)
		gLetter := choiceLetter(options, given)
		if cLetter != "" && gLetter != "" {
			return cLetter == gLetter
		}
	}
	// No options (fill-in) or unresolvable letters: fall back to exact compare.
	return correct == given
}

// choiceLetter resolves an answer to its option letter A/B/C…; empty when it
// cannot be resolved. Handles a bare letter ("B"), the full option text
// ("B. 收敛") and the label-less text ("收敛").
func choiceLetter(options []string, answer string) string {
	a := strings.TrimSpace(answer)
	if a == "" {
		return ""
	}
	if len(a) == 1 && a[0] >= 'A' && a[0] <= 'Z' {
		return a
	}
	for i, opt := range options {
		t := strings.TrimSpace(opt)
		if t == a || stripOptionLabel(t) == a {
			return string(rune('A' + i))
		}
	}
	return ""
}

// stripOptionLabel removes a leading letter label ("A. ", "B、", "C) ", "D ")
// from an option; returns the input unchanged when there is no label.
func stripOptionLabel(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return s
	}
	first := t[0]
	isLetter := (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z')
	if !isLetter {
		return s
	}
	rest := t[1:]
	for _, sep := range []string{".", "、", ")", "）", ":", "：", " ", "	"} {
		if strings.HasPrefix(rest, sep) {
			return strings.TrimSpace(rest[len(sep):])
		}
	}
	return s
}

func stringValue(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func stringSlice(v interface{}) []string {
	switch vv := v.(type) {
	case []string:
		return vv
	case []interface{}:
		out := make([]string, 0, len(vv))
		for _, item := range vv {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// parseCCEmails decodes the JSON column; Python's json.loads(row.cc_emails or "[]").
func parseCCEmails(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(*raw), &out); err != nil {
		return []string{}
	}
	return out
}

// CreateTaskQuizRow persists the generating business row. Duplicate task_id is
// treated as an idempotent re-trigger (200, no error) — the executor retries
// are safe.
func (s *Store) CreateTaskQuizRow(ctx context.Context, taskID string, uid int64, prompt, difficulty string, questionCount int, userEmail string, ccEmails []string, incompleteMessage *string) *APIError {
	if strings.TrimSpace(taskID) == "" {
		return &APIError{Status: 400, Detail: "task_id 不能为空"}
	}
	if strings.TrimSpace(prompt) == "" {
		return &APIError{Status: 400, Detail: "prompt 不能为空"}
	}
	if questionCount < 1 || questionCount > 5 {
		questionCount = maxInt(1, minInt(questionCount, 5))
	}
	if strings.TrimSpace(difficulty) == "" {
		difficulty = "medium"
	}
	err := repo.CreateTaskQuizRow(ctx, s.DB, taskID, uid, prompt, difficulty, questionCount, userEmail, ccEmails, incompleteMessage)
	if err != nil {
		if isDuplicateKey(err) {
			return nil
		}
		return &APIError{Status: 500, Detail: "内部错误"}
	}
	return nil
}

// MarkTaskQuizGenerated flips the row to awaiting_answer with the deadline.
func (s *Store) MarkTaskQuizGenerated(ctx context.Context, taskID string, deadline time.Time, questionCount int) *APIError {
	if err := repo.MarkTaskQuizGenerated(ctx, s.DB, taskID, deadline, questionCount); err != nil {
		return &APIError{Status: 500, Detail: "内部错误"}
	}
	return nil
}

// isDuplicateKey reports a MySQL duplicate-key violation (error 1062).
func isDuplicateKey(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// QuizSignals assembles the user's answered-question entity signals for the
// blindspot attribution (recent submissions → answers → Mongo attributions).
func (s *Store) QuizSignals(ctx context.Context, uid int64, limit int) ([]map[string]interface{}, *APIError) {
	subs, err := repo.ListQuizSignalSubmissions(ctx, s.DB, uid, limit)
	if err != nil {
		return nil, &APIError{Status: 500, Detail: "内部错误"}
	}
	subUUIDs := make([]string, 0, len(subs))
	quizBySub := make(map[string]string, len(subs))
	for _, sub := range subs {
		subUUIDs = append(subUUIDs, sub.SubmissionUUID)
		quizBySub[sub.SubmissionUUID] = sub.QuizUUID
	}
	answers, err := repo.ListQuizSignalAnswers(ctx, s.DB, subUUIDs)
	if err != nil {
		return nil, &APIError{Status: 500, Detail: "内部错误"}
	}
	quizUUIDs := make([]string, 0, len(quizBySub))
	seen := make(map[string]struct{})
	for _, q := range quizBySub {
		if _, ok := seen[q]; !ok {
			seen[q] = struct{}{}
			quizUUIDs = append(quizUUIDs, q)
		}
	}
	attributions, err := repo.GetQuestionAttributions(ctx, s.Mongo, quizUUIDs)
	if err != nil {
		return nil, &APIError{Status: 500, Detail: "内部错误"}
	}
	out := make([]map[string]interface{}, 0, len(answers))
	for _, a := range answers {
		attr := attributions[a.QuestionUUID]
		out = append(out, map[string]interface{}{
			"quiz_uuid":        quizBySub[a.SubmissionUUID],
			"question_uuid":    a.QuestionUUID,
			"is_correct":       a.IsCorrect,
			"question_text":    attr.QuestionText,
			"related_entities": attr.RelatedEntities,
		})
	}
	return out, nil
}
