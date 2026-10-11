// Internal grading endpoints for app-ts's grader: read the full question set
// (answers included) and persist a graded submission with its per-answer rows.
package router

import (
	"encoding/json"
	"net/http"
	"strings"

	"app-quiz/internal/repo"
	"app-quiz/internal/service"

	"github.com/gin-gonic/gin"
)

type gradingPayloadReq struct {
	UID      FlexInt64 `json:"uid"`
	QuizUUID string    `json:"quiz_uuid"`
}

func gradingPayloadHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req gradingPayloadReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		quizUUID := strings.TrimSpace(req.QuizUUID)
		if quizUUID == "" {
			apiErr(c, http.StatusBadRequest, "quiz_uuid 必填")
			return
		}
		out, apiError := svc.GradingPayload(c.Request.Context(), uid, quizUUID)
		if apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

type submissionAnswerReq struct {
	QuestionUUID          string          `json:"question_uuid"`
	QuestionType          string          `json:"question_type"`
	UserAnswer            json.RawMessage `json:"user_answer"`
	UserAnswerText        *string         `json:"user_answer_text"`
	IsCorrect             *bool           `json:"is_correct"`
	AutoScore             *int            `json:"auto_score"`
	CorrectAnswerSnapshot json.RawMessage `json:"correct_answer_snapshot"`
	MatchedKeywords       json.RawMessage `json:"matched_keywords"`
	KeywordMatchRate      *float64        `json:"keyword_match_rate"`
	GradingDetail         json.RawMessage `json:"grading_detail"`
}

type submissionReq struct {
	UID                FlexInt64             `json:"uid"`
	QuizUUID           string                `json:"quiz_uuid"`
	TotalQuestionCount int                   `json:"total_question_count"`
	PassingScore       *int                  `json:"passing_score"`
	TotalScore         int                   `json:"total_score"`
	CorrectCount       int                   `json:"correct_count"`
	Passed             *bool                 `json:"passed"`
	TimeSpentSeconds   *int                  `json:"time_spent_seconds"`
	Answers            []submissionAnswerReq `json:"answers"`
}

func rawOrNil(raw json.RawMessage) interface{} {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

func createSubmissionHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req submissionReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		answers := make([]repo.GradedAnswerInput, 0, len(req.Answers))
		for _, a := range req.Answers {
			answers = append(answers, repo.GradedAnswerInput{
				QuestionUUID:          a.QuestionUUID,
				QuestionType:          a.QuestionType,
				UserAnswer:            rawOrNil(a.UserAnswer),
				UserAnswerText:        a.UserAnswerText,
				IsCorrect:             a.IsCorrect,
				AutoScore:             a.AutoScore,
				CorrectAnswerSnapshot: rawOrNil(a.CorrectAnswerSnapshot),
				MatchedKeywords:       rawOrNil(a.MatchedKeywords),
				KeywordMatchRate:      a.KeywordMatchRate,
				GradingDetail:         rawOrNil(a.GradingDetail),
			})
		}
		out, apiError := svc.CreateSubmission(c.Request.Context(), uid, repo.GradedSubmissionInput{
			QuizUUID:           req.QuizUUID,
			TotalQuestionCount: req.TotalQuestionCount,
			PassingScore:       req.PassingScore,
			TotalScore:         req.TotalScore,
			CorrectCount:       req.CorrectCount,
			Passed:             req.Passed,
			TimeSpentSeconds:   req.TimeSpentSeconds,
			Answers:            answers,
		})
		if apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, out)
	}
}
