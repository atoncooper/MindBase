// Scheduled-quiz business endpoints — port of app/routers/task_answer.py
// (GET /tasks/{id}/detail, POST /tasks/{id}/answer). The scheduler endpoints
// (/tasks, /tasks/{id}) stay in the external app-task service; APISIX routes
// the two business paths here at priority 100.
package router

import (
	"net/http"
	"strings"

	"app-quiz/internal/service"

	"github.com/gin-gonic/gin"
)

type taskQuizAnswerItem struct {
	QuestionIndex int    `json:"question_index"`
	Answer        string `json:"answer"`
}

// taskQuizAnswerBody accepts the multi-answer form and the legacy single answer.
type taskQuizAnswerBody struct {
	Answers []taskQuizAnswerItem `json:"answers"`
	Answer  *string              `json:"answer"`
}

func registerTaskQuiz(e *gin.Engine, svc *service.Store) {
	g := e.Group("/tasks")
	g.GET("/:task_id/detail", taskQuizDetailHandler(svc))
	g.POST("/:task_id/answer", taskQuizAnswerHandler(svc))
}

func taskQuizDetailHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		taskID := strings.TrimSpace(c.Param("task_id"))
		if taskID == "" {
			apiErr(c, http.StatusBadRequest, "task_id 不合法")
			return
		}
		out, apiError := svc.TaskQuizDetail(c.Request.Context(), uid, taskID)
		if apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func taskQuizAnswerHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		taskID := strings.TrimSpace(c.Param("task_id"))
		if taskID == "" {
			apiErr(c, http.StatusBadRequest, "task_id 不合法")
			return
		}
		var body taskQuizAnswerBody
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		answers := make([]service.TaskQuizAnswerInput, 0, len(body.Answers))
		switch {
		case len(body.Answers) > 0:
			for _, a := range body.Answers {
				answers = append(answers, service.TaskQuizAnswerInput{
					QuestionIndex: a.QuestionIndex,
					Answer:        a.Answer,
				})
			}
		case body.Answer != nil:
			answers = append(answers, service.TaskQuizAnswerInput{QuestionIndex: 0, Answer: *body.Answer})
		default:
			apiErr(c, http.StatusBadRequest, "answer or answers required")
			return
		}
		out, apiError := svc.SubmitTaskQuizAnswer(c.Request.Context(), uid, taskID, answers)
		if apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, out)
	}
}
