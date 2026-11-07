// Grade persistence — the app-ts grader computes the verdicts; this package
// stores the submission row plus the per-answer rows (Python
// quiz_grader._create_submission/_save_answer/_update_submission parity).
package repo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// GradedAnswerInput is one graded quiz_answers row. JSON-ish fields may be
// passed as pre-marshalled strings (already JSON) or as Go values.
type GradedAnswerInput struct {
	QuestionUUID          string
	QuestionType          string
	UserAnswer            interface{}
	UserAnswerText        *string
	IsCorrect             *bool
	AutoScore             *int
	CorrectAnswerSnapshot interface{}
	MatchedKeywords       interface{}
	KeywordMatchRate      *float64
	GradingDetail         interface{}
}

// GradedSubmissionInput is the complete graded submission.
type GradedSubmissionInput struct {
	QuizUUID           string
	UID                int64
	TotalQuestionCount int
	PassingScore       *int
	TotalScore         int
	CorrectCount       int
	Passed             *bool
	TimeSpentSeconds   *int
	Answers            []GradedAnswerInput
}

func jsonPayload(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	switch s := v.(type) {
	case string:
		return s // already JSON (or a plain string column value)
	case json.RawMessage:
		if len(s) == 0 {
			return nil
		}
		return string(s)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		return string(raw)
	}
}

// CreateGradedSubmission inserts the final quiz_submissions row and its
// quiz_answers rows in one transaction; returns submission_uuid.
func CreateGradedSubmission(ctx context.Context, db *gorm.DB, in GradedSubmissionInput) (string, error) {
	submissionUUID := uuid.NewString()
	now := time.Now().UTC()
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(
			"INSERT INTO quiz_submissions "+
				"(submission_uuid, quiz_uuid, uid, total_score, auto_score, passing_score, "+
				"is_complete, is_passed, correct_count, total_question_count, time_spent_seconds, "+
				"started_at, submitted_at, graded_at) "+
				"VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
			submissionUUID, in.QuizUUID, in.UID, in.TotalScore, in.TotalScore, in.PassingScore,
			in.Passed, in.CorrectCount, in.TotalQuestionCount, in.TimeSpentSeconds, now, now, now,
		).Error; err != nil {
			return err
		}
		for _, a := range in.Answers {
			if err := tx.Exec(
				"INSERT INTO quiz_answers "+
					"(submission_uuid, question_uuid, question_type, user_answer, user_answer_text, "+
					"is_correct, auto_score, correct_answer_snapshot, matched_keywords, keyword_match_rate, "+
					"grading_detail, submitted_at, graded_at) "+
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				submissionUUID, a.QuestionUUID, a.QuestionType, jsonPayload(a.UserAnswer),
				a.UserAnswerText, a.IsCorrect, a.AutoScore, jsonPayload(a.CorrectAnswerSnapshot),
				jsonPayload(a.MatchedKeywords), a.KeywordMatchRate, jsonPayload(a.GradingDetail), now, now,
			).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return submissionUUID, nil
}
