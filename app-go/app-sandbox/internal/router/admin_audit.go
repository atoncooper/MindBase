package router

import (
	"net/http"
	"strings"

	"app-sandbox/internal/dto"
	"app-sandbox/internal/repo"

	"github.com/gin-gonic/gin"
)

// adminAudit returns one filtered page of the audit trail.
func adminAudit(c *gin.Context, d Deps) {
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
	result, err := d.Admin.Audit(c.Request.Context(), repo.AuditFilter{
		UID:      uid,
		Action:   strings.TrimSpace(c.Query("action")),
		From:     from,
		To:       to,
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewAuditAdminPage(result))
}
