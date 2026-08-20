package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// completeTask is the async callback from a third-party executor that accepted
// a task (202): it reports the final outcome and the scheduler advances
// running -> completed | failed. Key-auth via APISIX.
func (r *Router) completeTask(c *gin.Context) {
	taskID := c.Param("task_id")
	var req struct {
		Status string `json:"status" binding:"required"` // completed | failed
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	status, err := r.taskSvc.CompleteTask(taskID, req.Status, req.Result, req.Error)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": status})
}
