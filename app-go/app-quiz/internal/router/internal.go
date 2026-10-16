// Internal M2M endpoints for quiz storage writes — consumed by app-quiz-mcp
// (save_quiz / save_grading) and by app-ts's AI generation flows (create a
// generating set, finalize with questions, or fail) via the APISIX key-auth
// route /internal/quiz/*. Identity model mirrors every other internal surface:
// the caller forwards the gateway-authenticated uid as X-Uid; missing/invalid
// → 401. A body uid, when present, must agree with it.
package router

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-quiz/internal/repo"
	"app-quiz/internal/service"

	"github.com/gin-gonic/gin"
)

// FlexInt64 accepts a JSON number OR a numeric string for int64 uid fields.
// app-ts now carries uid as a string (int64 precision safety in JS), so M2M
// bodies may hold either shape; the X-Uid header stays authoritative.
type FlexInt64 int64

func (f *FlexInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*f = FlexInt64(v)
	return nil
}

func registerInternalQuiz(e *gin.Engine, svc *service.Store) {
	ig := e.Group("/internal/quiz")
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
		var req struct {
			UID               FlexInt64 `json:"uid"`
			TaskID            string    `json:"task_id"`
			Prompt            string    `json:"prompt"`
			Difficulty        string    `json:"difficulty"`
			QuestionCount     int       `json:"question_count"`
			UserEmail         string    `json:"user_email"`
			CCEmails          []string  `json:"cc_emails"`
			IncompleteMessage *string   `json:"incomplete_message"`
		}
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
		c.JSON(http.StatusOK, gin.H{"ok": true})
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
		var req struct {
			DeadlineSeconds int `json:"deadline_seconds"`
		}
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
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// agentQuizSetReq is the superset of the simple agent payload and the rich
// async-generation payload. With questions it behaves as before (status done);
// without questions it creates a generating row.
type agentQuizSetReq struct {
	UID              FlexInt64                `json:"uid"`
	QuizUUID         string                   `json:"quiz_uuid,omitempty"`
	Title            string                   `json:"title"`
	Difficulty       string                   `json:"difficulty,omitempty"`
	QuestionCount    *int                     `json:"question_count,omitempty"`
	TypeDistribution map[string]int           `json:"type_distribution,omitempty"`
	FolderIDs        []int64                  `json:"folder_ids,omitempty"`
	SourceType       string                   `json:"source_type,omitempty"`
	SourcePages      []map[string]interface{} `json:"source_pages,omitempty"`
	ChatSessionID    *string                  `json:"chat_session_id,omitempty"`
	Status           string                   `json:"status,omitempty"`
	TotalScore       *int                     `json:"total_score,omitempty"`
	PassingScore     *int                     `json:"passing_score,omitempty"`
	Questions        []service.AgentQuestion  `json:"questions"`
}

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
		if len(req.Questions) > 0 {
			result, err := svc.CreateAgentQuizSet(c.Request.Context(), uid, req.Title, req.Questions)
			if err != nil {
				respondAgentError(c, err)
				return
			}
			c.JSON(http.StatusOK, result)
			return
		}
		result, err := svc.CreateQuizSet(c.Request.Context(), uid, service.QuizSetDraft{
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
		})
		if err != nil {
			respondAgentError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	}
}

type agentQuizQuestionsReq struct {
	UID            FlexInt64               `json:"uid"`
	Status         string                  `json:"status"`
	Questions      []service.AgentQuestion `json:"questions"`
	QualityMetrics json.RawMessage         `json:"quality_metrics,omitempty"`
	BVIDCount      int                     `json:"bvid_count,omitempty"`
}

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
		result, err := svc.FinalizeQuizSet(c.Request.Context(), uid, quizUUID, req.Status, req.Questions, req.QualityMetrics, req.BVIDCount)
		if err != nil {
			respondAgentError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
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
		result, err := svc.AppendQuestions(c.Request.Context(), uid, quizUUID, req.Questions)
		if err != nil {
			respondAgentError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	}
}

type agentQuizProgressReq struct {
	UID    FlexInt64 `json:"uid"`
	Stage  string    `json:"stage"`
	Detail string    `json:"detail"`
	Stored int       `json:"stored"`
	Total  int       `json:"total"`
}

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
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

type agentQuizFailReq struct {
	UID          FlexInt64 `json:"uid"`
	ErrorMessage string    `json:"error_message"`
}

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
		c.JSON(http.StatusOK, result)
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
		var req struct {
			UID FlexInt64 `json:"uid"`
		}
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
		c.JSON(http.StatusOK, result)
	}
}

type agentGradingReq struct {
	UID         FlexInt64              `json:"uid"`
	QuizUUID    string                 `json:"quiz_uuid"`
	Score       int                    `json:"score"`
	Total       int                    `json:"total"`
	PerQuestion []service.AgentVerdict `json:"per_question"`
}

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
		result, err := svc.SaveAgentGrading(c.Request.Context(), uid, req.QuizUUID, req.Score, req.Total, req.PerQuestion)
		if err != nil {
			respondAgentError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	}
}

// respondAgentError maps validation errors to 400, content-disabled (Mongo
// down) to 503, everything else to 500 — the MCP/HTTP layer renders the detail.
func respondAgentError(c *gin.Context, err error) {
	// 底层错误必须落日志:对外只渲染通用 detail,没有这行就永远查不到原因
	if !errors.Is(err, service.ErrInvalidInput) && !errors.Is(err, repo.ErrContentDisabled) {
		slog.Error("[QUIZ] agent write failed", "err", err)
	}
	if errors.Is(err, service.ErrInvalidInput) {
		apiErr(c, http.StatusBadRequest, err.Error())
		return
	}
	if errors.Is(err, repo.ErrContentDisabled) {
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
		c.JSON(http.StatusOK, gin.H{"signals": signals})
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
		resp, err := svc.WrongAnswers(uid, nil)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "读取错题记录失败")
			return
		}
		items, _ := resp["wrong_answers"].([]map[string]interface{})
		if len(items) > limit {
			items = items[:limit]
		}
		c.JSON(http.StatusOK, gin.H{"wrong_answers": items, "total": len(items)})
	}
}
