package router

import (
	"net/http"
	"strings"

	"app-sandbox/internal/dto"

	"github.com/gin-gonic/gin"
)

// adminQuota returns one uid's usage for a day plus the resolved tier limits.
func adminQuota(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	if uid == nil {
		apiErr(c, http.StatusBadRequest, "uid 必填")
		return
	}
	snap, err := d.Admin.Quota(c.Request.Context(), *uid, strings.TrimSpace(c.Query("day")))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewQuotaView(snap))
}
