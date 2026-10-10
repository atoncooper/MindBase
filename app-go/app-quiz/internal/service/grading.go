package service

import (
	"context"

	"app-quiz/internal/repo"
)

// GradingPayload returns the owned quiz set meta + full question documents
// (answers included) for app-ts's grader.
func (s *Store) GradingPayload(ctx context.Context, uid int64, quizUUID string) (map[string]interface{}, *APIError) {
	if uid <= 0 {
		return nil, apiErr(401, "缺少用户身份")
	}
	set, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, apiErr(500, "查询失败，请稍后重试")
	}
	if set == nil || set.Status == nil || *set.Status != "done" {
		return nil, apiErr(404, "题目集不存在")
	}
	questions := repo.GetQuestionsFull(ctx, s.Mongo, quizUUID)
	if questions == nil {
		questions = []repo.QuestionDoc{}
	}
	return map[string]interface{}{
		"set": map[string]interface{}{
			"quiz_uuid":     set.QuizUUID,
			"passing_score": set.PassingScore,
			"total_score":   set.TotalScore,
			"status":        set.Status,
		},
		"questions": questions,
	}, nil
}

// CreateSubmission persists a graded submission (+ per-answer rows).
func (s *Store) CreateSubmission(ctx context.Context, uid int64, input repo.GradedSubmissionInput) (map[string]interface{}, *APIError) {
	if uid <= 0 {
		return nil, apiErr(401, "缺少用户身份")
	}
	if input.QuizUUID == "" {
		return nil, apiErr(400, "quiz_uuid 必填")
	}
	input.UID = uid
	submissionUUID, err := repo.CreateGradedSubmission(ctx, s.DB, input)
	if err != nil {
		return nil, apiErr(500, "保存失败，请稍后重试")
	}
	return map[string]interface{}{"submission_uuid": submissionUUID}, nil
}
