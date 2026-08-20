package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// sendEmail accepts a standardized email from a third-party executor and
// queues it for delivery (email_queue + worker with retries). Contract:
//
	//   {"to":["a@x.com"], "cc":["c@x.com"], "subject":"...", "html":"<div>...</div>", "reference_id":"task-xxx"}
//
// to/subject/html are required; cc and reference_id optional. The scheduler
// platform only understands this mail format — the executor renders the
// content (business side). Key-auth via APISIX.
func (r *Router) sendEmail(c *gin.Context) {
	var req struct {
		To          []string `json:"to" binding:"required"`
		CC          []string `json:"cc"`
		Subject     string   `json:"subject" binding:"required,max=255"`
		HTML        string   `json:"html" binding:"required"`
		ReferenceID string   `json:"reference_id" binding:"max=64"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	emailID, err := r.emailSvc.Enqueue(req.To, req.CC, req.Subject, req.HTML, req.ReferenceID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"email_id": emailID, "status": "queued"})
}
