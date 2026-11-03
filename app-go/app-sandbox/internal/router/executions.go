package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/runtime"
	"app-sandbox/internal/service"

	"github.com/gin-gonic/gin"
)

// createExecutionRequest is the POST /v1/executions body. uid is accepted for
// readability but IGNORED: identity always comes from the X-Uid header.
const maxCreateBodyBytes = 4 << 20

type createExecutionRequest struct {
	ProjectID string         `json:"projectId"`
	Purpose   string         `json:"purpose"`
	Language  string         `json:"language"`
	Code      string         `json:"code"`
	Files     []runtime.File `json:"files"`
	Artifacts []string       `json:"artifacts"`
	TimeoutMS int            `json:"timeoutMs"`
}

func registerExecutions(g *gin.RouterGroup, d Deps) {
	g.POST("/executions", func(c *gin.Context) { createExecution(c, d) })
	g.GET("/executions/:id", func(c *gin.Context) { getExecution(c, d) })
	g.GET("/executions/:id/events", func(c *gin.Context) { executionEvents(c, d) })
	g.POST("/executions/:id/cancel", func(c *gin.Context) { cancelExecution(c, d) })
}

func createExecution(c *gin.Context, d Deps) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCreateBodyBytes)
	var body createExecutionRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		apiErr(c, http.StatusBadRequest, "请求体格式错误")
		return
	}
	exec, err := d.Executions.Create(c.Request.Context(), service.CreateRequest{
		UID:            currentUID(c),
		ProjectID:      body.ProjectID,
		Purpose:        body.Purpose,
		Language:       body.Language,
		Code:           body.Code,
		Files:          body.Files,
		ArtifactGlobs:  body.Artifacts,
		TimeoutMS:      body.TimeoutMS,
		RequestID:      currentRequestID(c),
		IdempotencyKey: c.GetHeader("Idempotency-Key"),
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{
		"executionId": exec.ID,
		"leaseId":     exec.LeaseID,
		"state":       exec.Status,
	})
}

func getExecution(c *gin.Context, d Deps) {
	view, err := d.Executions.Get(c.Request.Context(), currentUID(c), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, executionPayload(view))
}

func cancelExecution(c *gin.Context, d Deps) {
	if err := d.Executions.Cancel(c.Request.Context(), currentUID(c), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// executionEvents streams SSE frames: status / stdout / stderr / artifact / done.
func executionEvents(c *gin.Context, d Deps) {
	uid := currentUID(c)
	history, events, cancel, err := d.Executions.Events(c.Request.Context(), uid, c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	defer cancel()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		apiErr(c, http.StatusInternalServerError, "SSE 不受支持")
		return
	}
	writeEvent := func(ev service.Event) bool {
		payload, merr := json.Marshal(ev.Data)
		if merr != nil {
			return true
		}
		if _, werr := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", ev.Type, payload); werr != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for _, ev := range history {
		if !writeEvent(ev) {
			return
		}
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev, open := <-events:
			if !open {
				return
			}
			if !writeEvent(ev) {
				return
			}
		}
	}
}

// executionPayload flattens the entity plus artifact views into the public
// response shape (plan §4).
func executionPayload(view *service.ExecutionView) gin.H {
	exec := view.Execution
	body := gin.H{
		"executionId":   exec.ID,
		"leaseId":       exec.LeaseID,
		"projectId":     exec.ProjectID,
		"purpose":       exec.Purpose,
		"language":      exec.Language,
		"status":        exec.Status,
		"timeoutMs":     exec.TimeoutMS,
		"stdoutPreview": exec.StdoutPreview,
		"stderrPreview": exec.StderrPreview,
		"stdoutBytes":   exec.StdoutBytes,
		"stderrBytes":   exec.StderrBytes,
		"errorCode":     exec.ErrorCode,
		"createdAt":     exec.CreatedAt,
		"artifacts":     view.Artifacts,
	}
	if exec.ExitCode != nil {
		body["exitCode"] = *exec.ExitCode
	}
	if exec.StartedAt != nil {
		body["startedAt"] = *exec.StartedAt
	}
	if exec.FinishedAt != nil {
		body["finishedAt"] = *exec.FinishedAt
	}
	if exec.StartedAt != nil && exec.FinishedAt != nil {
		body["durationMs"] = exec.FinishedAt.Sub(*exec.StartedAt).Milliseconds()
	}
	if !model.IsExecTerminal(exec.Status) {
		body["done"] = false
	} else {
		body["done"] = true
	}
	return body
}
