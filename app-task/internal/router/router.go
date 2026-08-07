// Package router wires Gin routes + handlers. Auth model: APISIX forward-auth
// injects X-Uid for user endpoints; /tasks/register trusts key-auth (uid in body).
package router

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-task/internal/config"
	"app-task/internal/logger"
	"app-task/internal/repo"
	"app-task/internal/service"

	"github.com/gin-gonic/gin"
)

// New builds the Gin engine with all routes registered.
func New(taskSvc *service.TaskService, cfg *config.Config) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins))

	r := &Router{taskSvc: taskSvc}
	r.registerRoutes(e)
	return e
}

type Router struct {
	taskSvc *service.TaskService
}

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-task"})
	})
	e.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"service": "app-task", "version": "0.2.0", "status": "running"})
	})

	tasks := e.Group("/tasks")
	tasks.POST("/register", r.register)
	tasks.POST("/:task_id/answer", r.answer)
	tasks.GET("/:task_id", r.detail)
	tasks.GET("", r.list)
}

func (r *Router) register(c *gin.Context) {
	var req struct {
		UID               int64    `json:"uid" binding:"required"`
		UserEmail         string   `json:"user_email" binding:"required"`
		CCEmails          []string `json:"cc_emails"`
		Prompt            string   `json:"prompt" binding:"required,max=500"`
		Difficulty        string   `json:"difficulty"`
		TriggerTime       string   `json:"trigger_time" binding:"required"`
		IncompleteMessage *string  `json:"incomplete_message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	triggerTime, err := parseISO8601(req.TriggerTime)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid trigger_time (expect ISO8601)"})
		return
	}
	incomplete := ""
	if req.IncompleteMessage != nil {
		incomplete = *req.IncompleteMessage
	}
	taskID, err := r.taskSvc.RegisterTask(req.UID, req.UserEmail, req.CCEmails, req.Prompt, req.Difficulty, triggerTime, incomplete)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "register failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": "pending"})
}

func (r *Router) answer(c *gin.Context) {
	uid, ok := uidFromHeader(c)
	if !ok {
		return
	}
	taskID := c.Param("task_id")
	var req struct {
		Answer string `json:"answer" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	result, err := r.taskSvc.SubmitAnswer(taskID, uid, req.Answer)
	if err == service.ErrNotFound {
		c.JSON(http.StatusNotFound, gin.H{"detail": "task not found"})
		return
	}
	if err == service.ErrForbidden {
		c.JSON(http.StatusForbidden, gin.H{"detail": "not the task owner"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

func (r *Router) detail(c *gin.Context) {
	uid, ok := uidFromHeader(c)
	if !ok {
		return
	}
	taskID := c.Param("task_id")
	task, err := repo.GetTaskByID(taskID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	if task == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "task not found"})
		return
	}
	if task.UID != uid {
		c.JSON(http.StatusForbidden, gin.H{"detail": "not the task owner"})
		return
	}
	quiz, _ := repo.GetQuizByTaskID(c.Request.Context(), taskID)
	ans, _ := repo.GetAnswerByTaskID(taskID)
	resp := gin.H{
		"task_id":      task.TaskID,
		"uid":          task.UID,
		"prompt":       task.Prompt,
		"status":       task.Status,
		"trigger_time": task.TriggerTime.Format(time.RFC3339),
		"cc_emails":    task.CCEmails,
		"quiz":         quiz,
		"answer":       nil,
	}
	if ans != nil {
		resp["answer"] = gin.H{
			"answer":       ans.Answer,
			"is_correct":   ans.IsCorrect,
			"submitted_at": ans.SubmittedAt.Format(time.RFC3339),
		}
	}
	c.JSON(http.StatusOK, resp)
}

func (r *Router) list(c *gin.Context) {
	uid, ok := uidFromHeader(c)
	if !ok {
		return
	}
	tasks, err := repo.ListTasksByUID(uid, 50, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, gin.H{
			"task_id":      t.TaskID,
			"prompt":       t.Prompt,
			"status":       t.Status,
			"trigger_time": t.TriggerTime.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"tasks": out})
}

func uidFromHeader(c *gin.Context) (int64, bool) {
	s := c.GetHeader("X-Uid")
	if s == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "unauthorized (X-Uid missing)"})
		return 0, false
	}
	uid, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "invalid X-Uid"})
		return 0, false
	}
	return uid, true
}

func parseISO8601(s string) (time.Time, error) {
	s = strings.Replace(s, "Z", "+00:00", 1)
	return time.Parse(time.RFC3339, s)
}

func corsMiddleware(allowOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, o := range allowOrigins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
