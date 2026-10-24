// Shared query-param helpers for the paginated read endpoints (users /
// shares / audit): page starts at 1, pageSize in 1..100, default 20
// (plan/1.0.16 pagination convention).
package router

import (
	"strconv"

	"github.com/gin-gonic/gin"
)

const (
	defaultPageSize = 20
	maxPageSize     = 100
)

// parsePage normalises ?page / ?pageSize. Returns (page, pageSize, ok); ok is
// false when the params are present but not sane integers.
func (r *Router) parsePage(c *gin.Context) (page, pageSize int, ok bool) {
	page, pageSize = 1, defaultPageSize
	if v := c.Query("page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, false
		}
		page = n
	}
	if v := c.Query("pageSize"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, 0, false
		}
		pageSize = n
	}
	if page < 1 || pageSize < 1 || pageSize > maxPageSize {
		return 0, 0, false
	}
	return page, pageSize, true
}
