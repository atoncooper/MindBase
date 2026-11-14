package router

import (
	"net/http"
	"strconv"
	"strings"

	"app-sandbox/internal/dto"

	"github.com/gin-gonic/gin"
)

// Public list limit contract: ?limit= is optional, defaults to 20 and is
// clamped to [1, 50] (docs/research-ui-api.md §7).
const (
	defaultListLimit = 20
	maxListLimit     = 50
)

// parseListLimit normalizes ?limit=. Missing, non-numeric and non-positive
// values fall back to the default; anything above the cap is clamped.
func parseListLimit(raw string) int {
	limit, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || limit <= 0 {
		return defaultListLimit
	}
	if limit > maxListLimit {
		return maxListLimit
	}
	return limit
}

// listExecutions returns the current user's executions (newest first). Identity
// always comes from the gateway-injected X-Uid; a user can never list another
// user's rows.
func listExecutions(c *gin.Context, d Deps) {
	views, err := d.Executions.ListByUID(c.Request.Context(), currentUID(c), parseListLimit(c.Query("limit")))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewExecutionListResponse(views))
}

// getExecution returns one uid-scoped execution (metadata + artifacts).
func getExecution(c *gin.Context, d Deps) {
	view, err := d.Executions.Get(c.Request.Context(), currentUID(c), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewExecutionPayload(view))
}

// cancelExecution cancels a queued/running execution (204, idempotent).
func cancelExecution(c *gin.Context, d Deps) {
	if err := d.Executions.Cancel(c.Request.Context(), currentUID(c), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
