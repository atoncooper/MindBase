package router

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
)

// register creates a pure scheduling task. The scheduler never interprets the
// payload — it is passed verbatim to the executor.
func (r *Router) register(c *gin.Context) {
	var req struct {
		UID         int64           `json:"uid" binding:"required"`
		TaskType     string          `json:"task_type"`     // http (default) / lua
		Payload     json.RawMessage `json:"payload"`      // opaque task parameters
		ExecutorURL string          `json:"executor_url"` // http mode: third-party executor endpoint
		Async       bool            `json:"async"`        // true: executor replies 202 + callback
		CronExpr    string          `json:"cron_expr"`    // 5-field cron; empty = one-shot
		TriggerTime string          `json:"trigger_time"` // required when cron_expr is empty
		MaxRetry    int             `json:"max_retry"`
		Weight      int             `json:"weight"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	var triggerTime time.Time
	if req.CronExpr == "" && req.TriggerTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "trigger_time required when cron_expr is empty"})
		return
	}
	if req.TriggerTime != "" {
		t, err := parseISO8601(req.TriggerTime)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid trigger_time (expect ISO8601)"})
			return
		}
		triggerTime = t
	}
	taskID, err := r.taskSvc.RegisterTask(req.UID, req.TaskType, req.Payload, req.ExecutorURL, req.Async, req.CronExpr, triggerTime, req.MaxRetry, req.Weight)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "register failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": "pending"})
}

// detail returns a task plus its recent execution log (溯源).
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
	logs, _ := repo.ListTaskLogs(taskID, 10)
	logOut := make([]gin.H, 0, len(logs))
	for _, l := range logs {
		logOut = append(logOut, gin.H{
			"trigger_at":  l.TriggerAt.Format(time.RFC3339),
			"executor":    l.Executor,
			"status":      l.Status,
			"duration_ms": l.DurationMS,
			"response":    l.Response,
			"error":       l.Error,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"task_id":       task.TaskID,
		"uid":          task.UID,
		"task_type":     task.TaskType,
		"status":       task.Status,
		"trigger_time": task.TriggerTime.Format(time.RFC3339),
		"executor_url": task.ExecutorURL,
		"async":        task.Async,
		"max_retry":    task.MaxRetry,
		"retry_count":  task.RetryCount,
		"last_result":  task.LastResult,
		"payload":      task.Payload,
		"logs":         logOut,
	})
}

// list returns the user's tasks, newest first.
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
	for _, j := range tasks {
		out = append(out, gin.H{
			"task_id":       j.TaskID,
			"task_type":     j.TaskType,
			"status":       j.Status,
			"trigger_time": j.TriggerTime.Format(time.RFC3339),
			"executor_url": j.ExecutorURL,
			"async":        j.Async,
			// Opaque payload passed through for display (e.g. prompt); the
			// scheduler never interprets it.
			"payload": j.Payload,
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
