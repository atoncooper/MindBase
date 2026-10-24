// Audit ledger endpoint (viewer+): GET /api/audit with optional exact-match
// action / admin filters, page / pageSize, newest first.
package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (r *Router) apiListAudit(c *gin.Context) {
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.audits.List(c.Query("action"), c.Query("admin"), page, pageSize)
	if err != nil {
		badRequest(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}
