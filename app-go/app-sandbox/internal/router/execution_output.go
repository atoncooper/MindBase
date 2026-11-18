package router

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// executionOutput serves paged full stdout/stderr for one terminal execution.
func executionOutput(c *gin.Context, d Deps) {
	if d.Executions == nil {
		apiErr(c, http.StatusServiceUnavailable, "执行服务未启用")
		return
	}
	offset := int64(0)
	if raw := strings.TrimSpace(c.Query("offset")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			apiErr(c, http.StatusBadRequest, "offset 必须是非负整数")
			return
		}
		offset = parsed
	}
	limit := int64(0)
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			apiErr(c, http.StatusBadRequest, "limit 必须是正整数")
			return
		}
		limit = parsed
	}
	result, err := d.Executions.Output(
		c.Request.Context(),
		currentUID(c),
		c.Param("id"),
		c.Query("stream"),
		offset,
		limit,
	)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}
