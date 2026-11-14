package router

import (
	"net/http"
	"strings"
	"time"

	"app-sandbox/internal/dto"
	"app-sandbox/internal/repo"

	"github.com/gin-gonic/gin"
)

// adminExecutions returns one filtered page of every uid's executions.
func adminExecutions(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	from, ok := parseTimeQuery(c, "from")
	if !ok {
		return
	}
	to, ok := parseTimeQuery(c, "to")
	if !ok {
		return
	}
	page, pageSize := parsePaging(c)
	result, err := d.Admin.Executions(c.Request.Context(), repo.ExecutionFilter{
		UID:       uid,
		ProjectID: strings.TrimSpace(c.Query("projectId")),
		Statuses:  parseCSV(c.Query("status")),
		From:      from,
		To:        to,
		Page:      page,
		PageSize:  pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewExecutionAdminPage(result, time.Now()))
}

// adminExecutionDetail returns the execution row plus artifact metadata and the
// audit trail (previews only, never the code body).
func adminExecutionDetail(c *gin.Context, d Deps) {
	detail, err := d.Admin.ExecutionDetail(c.Request.Context(), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewExecutionDetailView(detail, time.Now()))
}

// adminCancelExecution cancels any uid's queued/running execution (204).
func adminCancelExecution(c *gin.Context, d Deps) {
	if err := d.Admin.CancelExecution(c.Request.Context(), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
