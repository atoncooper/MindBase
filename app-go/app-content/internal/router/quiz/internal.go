// Internal M2M endpoints for quiz storage writes — consumed by app-content-mcp
// (save_quiz / save_grading) and by app-ts's AI generation flows (create a
// generating set, finalize with questions, or fail) via the APISIX key-auth
// route /internal/quiz/*. Identity model mirrors every other internal surface:
// the caller forwards the gateway-authenticated uid as X-Uid; missing/invalid
// → 401. A body uid, when present, must agree with it.
package router

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	quizdto "app-content/internal/dto/quiz"
	"app-content/internal/middleware"
	"app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
)

// toServiceQuestions maps the wire DTO to the service input at the boundary
// (the DTO package has no service dependency).
func toServiceQuestions(items []quizdto.AgentQuestion) []service.AgentQuestion {
	out := make([]service.AgentQuestion, 0, len(items))
	for _, q := range items {
		out = append(out, service.AgentQuestion{
			Question: q.Question, QuestionType: q.QuestionType, Difficulty: q.Difficulty,
			Score: q.Score, Options: q.Options, Answer: q.Answer,
			CorrectAnswer: q.CorrectAnswer, Explanation: q.Explanation, Keywords: q.Keywords,
			BVID: q.BVID, ChunkID: q.ChunkID, SourceSegment: q.SourceSegment,
			AnswerTemplate: q.AnswerTemplate, ScoringRubric: q.ScoringRubric, ModelAnswer: q.ModelAnswer,
		})
	}
	return out
}

// toServiceVerdicts maps wire verdicts to the service input.
func toServiceVerdicts(items []quizdto.AgentVerdict) []service.AgentVerdict {
	out := make([]service.AgentVerdict, 0, len(items))
	for _, v := range items {
		out = append(out, service.AgentVerdict{Index: v.Index, Verdict: v.Verdict, Feedback: v.Feedback})
	}
	return out
}

// FlexInt64 is the DTO dual number/string int64 shape.
type FlexInt64 = quizdto.FlexInt64

func registerInternalQuiz(e *gin.Engine, svc *service.Store, apiKey string) {
	ig := e.Group("/internal/quiz", middleware.InternalAuth(apiKey))
	ig.POST("/sets", createQuizSet(svc))
	ig.POST("/sets/:quiz_uuid/questions", finalizeQuizSet(svc))
	ig.POST("/sets/:quiz_uuid/questions/append", appendQuizQuestions(svc))
	ig.POST("/sets/:quiz_uuid/progress", updateQuizProgress(svc))
	ig.POST("/sets/:quiz_uuid/fail", failQuizSet(svc))
	// partial → generating：app-ts 断点续跑（checkpoint 增量题已保留，重开后续写）
	ig.POST("/sets/:quiz_uuid/reopen", reopenQuizSet(svc))
	ig.POST("/quota/peek", quotaPeekHandler(svc))
	ig.POST("/quota/consume", quotaConsumeHandler(svc))
	ig.POST("/grading", gradingPayloadHandler(svc))
	ig.POST("/submissions", createSubmissionHandler(svc))
	ig.GET("/wrong-answers", internalWrongAnswers(svc))
	ig.POST("/gradings", saveAgentGrading(svc))
	// scheduled-quiz business rows (written by app-ts's generate-llm flow)
	ig.GET("/quiz-signals", quizSignalsHandler(svc))
	ig.POST("/tasks", createTaskQuizRow(svc))
	ig.POST("/tasks/:task_id/generated", markTaskQuizGenerated(svc))
}

// createTaskQuizRow inserts the generating quiz_task row. The body uid must
// agree with the forwarded X-Uid (same trust model as the agent write face).
func createTaskQuizRow(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req quizdto.CreateTaskRowRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		if serr := svc.CreateTaskQuizRow(c.Request.Context(), req.TaskID, uid, req.Prompt, req.Difficulty, req.QuestionCount, req.UserEmail, req.CCEmails, req.IncompleteMessage); serr != nil {
			apiErr(c, serr.Status, serr.Detail)
			return
		}
		c.JSON(http.StatusOK, quizdto.OK{OK: true})
	}
}

// markTaskQuizGenerated flips generating → awaiting_answer and arms the
// deadline (body: deadline_seconds; falls back to the difficulty defaults).
func markTaskQuizGenerated(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := currentUID(c); !ok {
			return
		}
		taskID := c.Param("task_id")
		var req quizdto.MarkGeneratedRequest
		_ = c.ShouldBindJSON(&req)
		seconds := req.DeadlineSeconds
		if seconds <= 0 {
			seconds = 1200
		}
		deadline := time.Now().UTC().Add(time.Duration(seconds) * time.Second)
		if serr := svc.MarkTaskQuizGenerated(c.Request.Context(), taskID, deadline, 0); serr != nil {
			apiErr(c, serr.Status, serr.Detail)
			return
		}
		c.JSON(http.StatusOK, quizdto.OK{OK: true})
	}
}

// agentQuizSetReq is the superset of the simple agent payload and the rich
// async-generation payload. With questions it behaves as before (status done);
// without questions it creates a generating row.
type agentQuizSetReq = quizdto.AgentQuizSetRequest

func createQuizSet(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req agentQuizSetReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, err := svc.CreateSet(c.Request.Context(), uid, service.CreateSetOptions{
			QuizUUID:         req.QuizUUID,
			Title:            req.Title,
			Difficulty:       req.Difficulty,
			QuestionCount:    req.QuestionCount,
			TypeDistribution: req.TypeDistribution,
			FolderIDs:        req.FolderIDs,
			SourceType:       req.SourceType,
			SourcePages:      req.SourcePages,
			ChatSessionID:    req.ChatSessionID,
			Status:           req.Status,
			TotalScore:       req.TotalScore,
			PassingScore:     req.PassingScore,
			Questions:        toServiceQuestions(req.Questions),
		})
		if err != nil {
			respondAgentError(c, err)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

type agentQuizQuestionsReq = quizdto.AgentQuizQuestionsRequest

func finalizeQuizSet(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := strings.TrimSpace(c.Param("quiz_uuid"))
		var req agentQuizQuestionsReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, err := svc.FinalizeQuizSet(c.Request.Context(), uid, quizUUID, req.Status, toServiceQuestions(req.Questions), req.QualityMetrics, req.BVIDCount)
		if err != nil {
			respondAgentError(c, err)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

// appendQuizQuestions checkpoint：分批生成的增量落库（仅 generating 行）。
func appendQuizQuestions(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := strings.TrimSpace(c.Param("quiz_uuid"))
		var req agentQuizQuestionsReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, err := svc.AppendQuestions(c.Request.Context(), uid, quizUUID, toServiceQuestions(req.Questions))
		if err != nil {
			respondAgentError(c, err)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

type agentQuizProgressReq = quizdto.AgentQuizProgressRequest

func updateQuizProgress(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := strings.TrimSpace(c.Param("quiz_uuid"))
		var req agentQuizProgressReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		if err := svc.UpdateGenerationProgress(c.Request.Context(), uid, quizUUID, req.Stage, req.Detail, req.Stored, req.Total); err != nil {
			respondAgentError(c, err)
			return
		}
		c.JSON(http.StatusOK, quizdto.OK{OK: true})
	}
}

type agentQuizFailReq = quizdto.AgentQuizFailRequest

func failQuizSet(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := strings.TrimSpace(c.Param("quiz_uuid"))
		var req agentQuizFailReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, err := svc.FailQuizSet(c.Request.Context(), uid, quizUUID, req.ErrorMessage)
		if err != nil {
			respondAgentError(c, err)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

// reopenQuizSet flips an owned partial quiz back to generating so app-ts can
// continue the interrupted run (P2 断点续跑)。uid 一致性模型同 failQuizSet。
func reopenQuizSet(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		quizUUID := strings.TrimSpace(c.Param("quiz_uuid"))
		var req quizdto.ReopenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, aerr := svc.ReopenForResume(c.Request.Context(), uid, quizUUID)
		if aerr != nil {
			apiErr(c, aerr.Status, aerr.Detail)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

type agentGradingReq = quizdto.AgentGradingRequest

func saveAgentGrading(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req agentGradingReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		result, err := svc.SaveAgentGrading(c.Request.Context(), uid, req.QuizUUID, req.Score, req.Total, toServiceVerdicts(req.PerQuestion))
		if err != nil {
			respondAgentError(c, err)
			return
		}
		renderTyped[quizdto.AgentWriteResult](c, result)
	}
}

// respondAgentError maps validation errors to 400, content-disabled (Mongo
// down) to 503, everything else to 500 — the MCP/HTTP layer renders the detail.
func respondAgentError(c *gin.Context, err error) {
	// 底层错误必须落日志:对外只渲染通用 detail,没有这行就永远查不到原因
	if !errors.Is(err, service.ErrInvalidInput) && !errors.Is(err, service.ErrContentDisabled) {
		slog.Error("[QUIZ] agent write failed", "err", err)
	}
	if errors.Is(err, service.ErrInvalidInput) {
		apiErr(c, http.StatusBadRequest, err.Error())
		return
	}
	if errors.Is(err, service.ErrContentDisabled) {
		apiErr(c, http.StatusServiceUnavailable, "MongoDB 未连接，无法保存题目内容")
		return
	}
	apiErr(c, http.StatusInternalServerError, "保存失败，请稍后重试")
}

// quizSignalsHandler serves the blindspot attribution read (X-Uid scoped).
func quizSignalsHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		signals, serr := svc.QuizSignals(c.Request.Context(), uid, 200)
		if serr != nil {
			apiErr(c, serr.Status, serr.Detail)
			return
		}
		renderTyped[quizdto.SignalsResponse](c, map[string]interface{}{"signals": signals})
	}
}

// internalWrongAnswers exposes the user's wrong-answer notebook to app-ts's AI
// generation (error-profile driven quizzes). Same identity model as the rest of
// the internal face: gateway-authenticated X-Uid; optional limit (default 30,
// capped at 100) takes the most recent entries.
func internalWrongAnswers(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		limit := 30
		if n, err := strconv.Atoi(c.Query("limit")); err == nil && n > 0 {
			limit = n
		}
		if limit > 100 {
			limit = 100
		}
		resp, err := svc.WrongAnswers(c.Request.Context(), uid, nil)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "读取错题记录失败")
			return
		}
		items, _ := resp["wrong_answers"].([]map[string]interface{})
		if len(items) > limit {
			items = items[:limit]
		}
		renderTyped[quizdto.WrongAnswers](c, map[string]interface{}{"wrong_answers": items, "total": len(items)})
	}
}
