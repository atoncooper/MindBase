package router

import (
	"net/http"

	"app-sandbox/internal/dto"
	"app-sandbox/internal/service"

	"github.com/gin-gonic/gin"
)

// maxCreateBodyBytes bounds the POST /v1/executions body (code + inline files).
const maxCreateBodyBytes = 4 << 20

// createExecution accepts the request, delegates to the service and answers 202
// with the queued execution identity. uid is IGNORED in the body: identity always
// comes from the X-Uid header.
func createExecution(c *gin.Context, d Deps) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCreateBodyBytes)
	var body dto.CreateExecutionRequest
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
	c.JSON(http.StatusAccepted, dto.NewCreateExecutionResponse(exec))
}
