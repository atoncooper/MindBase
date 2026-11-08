package service

import (
	"context"

	"app-content/internal/repo/quiz"
)

// GradingPayload returns the owned quiz set meta + full question documents
// (answers included) for app-ts's grader.
func (s *Store) GradingPayload(ctx context.Context, uid int64, quizUUID string) (map[string]interface{}, *APIError) {
	if uid <= 0 {
		return nil, apiErr(401, "缺少用户身份")
	}
	set, err := s.Repo.GetOwnedQuizSet(ctx, quizUUID, uid)
	if err != nil {
		return nil, apiErr(500, "查询失败，请稍后重试")
	}
	if set == nil || set.Status == nil {
		return nil, apiErr(404, "题目集不存在")
	}
	// partial = 生成超时/中断收尾的不足量卷：已 checkpoint 落库的题目照常可答可判
	//（前端答题页对 partial 可见，提交被 404 拒绝属语义错误）。
	switch *set.Status {
	case "done", "partial":
		// 可判
	case "generating":
		return nil, apiErr(409, "题目正在生成中，请稍候再提交")
	default: // failed / deleting / lost 等终态不可判
		return nil, apiErr(404, "题目集不存在")
	}
	questions := s.Repo.GetQuestionsFull(ctx, quizUUID)
	if questions == nil {
		questions = []repo.QuestionDoc{}
	}
	return map[string]interface{}{
		"set": map[string]interface{}{
			"quiz_uuid":     set.QuizUUID,
			"passing_score": set.PassingScore,
			"total_score":   set.TotalScore,
			// resume 对账所需：目标题量/题型分布/难度/来源（app-ts 续跑重建记忆用）
			"question_count":    set.QuestionCount,
			"type_distribution": set.TypeDistribution,
			"difficulty":        set.Difficulty,
			"title":             set.Title,
			"source_type":       set.SourceType,
			"status":            set.Status,
		},
		"questions": questions,
	}, nil
}

// ErrContentDisabled re-exports the data-access sentinel so HTTP handlers map
// "Mongo not connected" to 503 without importing the repo package.
var ErrContentDisabled = repo.ErrContentDisabled

// SubmissionAnswer is one answer at the service boundary (DTO -> service).
// JSON-ish fields accept pre-marshalled strings or Go values; the repo layer
// normalises them.
type SubmissionAnswer struct {
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

// Submission is the complete graded submission at the service boundary.
// The authenticated uid is supplied separately and never trusted from input.
type Submission struct {
	QuizUUID           string
	TotalQuestionCount int
	PassingScore       *int
	TotalScore         int
	CorrectCount       int
	Passed             *bool
	TimeSpentSeconds   *int
	Answers            []SubmissionAnswer
}

// toRepoSubmission converts the service input into the repo row shape.
func toRepoSubmission(uid int64, input Submission) repo.GradedSubmissionInput {
	answers := make([]repo.GradedAnswerInput, 0, len(input.Answers))
	for _, a := range input.Answers {
		answers = append(answers, repo.GradedAnswerInput{
			QuestionUUID:          a.QuestionUUID,
			QuestionType:          a.QuestionType,
			UserAnswer:            a.UserAnswer,
			UserAnswerText:        a.UserAnswerText,
			IsCorrect:             a.IsCorrect,
			AutoScore:             a.AutoScore,
			CorrectAnswerSnapshot: a.CorrectAnswerSnapshot,
			MatchedKeywords:       a.MatchedKeywords,
			KeywordMatchRate:      a.KeywordMatchRate,
			GradingDetail:         a.GradingDetail,
		})
	}
	return repo.GradedSubmissionInput{
		QuizUUID:           input.QuizUUID,
		UID:                uid,
		TotalQuestionCount: input.TotalQuestionCount,
		PassingScore:       input.PassingScore,
		TotalScore:         input.TotalScore,
		CorrectCount:       input.CorrectCount,
		Passed:             input.Passed,
		TimeSpentSeconds:   input.TimeSpentSeconds,
		Answers:            answers,
	}
}

// CreateSubmission persists a graded submission (+ per-answer rows).
func (s *Store) CreateSubmission(ctx context.Context, uid int64, input Submission) (map[string]interface{}, *APIError) {
	if uid <= 0 {
		return nil, apiErr(401, "缺少用户身份")
	}
	if input.QuizUUID == "" {
		return nil, apiErr(400, "quiz_uuid 必填")
	}
	submissionUUID, err := s.Repo.CreateGradedSubmission(ctx, toRepoSubmission(uid, input))
	if err != nil {
		return nil, apiErr(500, "保存失败，请稍后重试")
	}
	return map[string]interface{}{"submission_uuid": submissionUUID}, nil
}
