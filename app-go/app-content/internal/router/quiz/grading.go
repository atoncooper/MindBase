// Internal grading endpoints for app-ts's grader: read the full question set
// (answers included) and persist a graded submission with its per-answer rows.
package router

import (
	quizdto "app-content/internal/dto/quiz"
	"encoding/json"
	"net/http"
	"strings"

	"app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
)

type gradingPayloadReq = quizdto.GradingPayloadRequest

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
		renderTyped[quizdto.GradingPayload](c, out)
	}
}

type submissionAnswerReq = quizdto.SubmissionAnswer

type submissionReq = quizdto.SubmissionRequest

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
		answers := make([]service.SubmissionAnswer, 0, len(req.Answers))
		for _, a := range req.Answers {
			answers = append(answers, service.SubmissionAnswer{
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
		out, apiError := svc.CreateSubmission(c.Request.Context(), uid, service.Submission{
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
		renderTyped[quizdto.AgentWriteResult](c, out)
	}
}
