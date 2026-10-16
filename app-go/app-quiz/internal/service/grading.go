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
	questions := repo.GetQuestionsFull(ctx, s.Mongo, quizUUID)
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
