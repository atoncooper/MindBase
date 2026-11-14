package router

import (
	"net/http"

	"app-sandbox/internal/dto"
	"app-sandbox/internal/repo"

	"github.com/gin-gonic/gin"
)

// adminLeases returns one filtered page of leases.
func adminLeases(c *gin.Context, d Deps) {
	uid, ok := parseUIDQuery(c)
	if !ok {
		return
	}
	page, pageSize := parsePaging(c)
	result, err := d.Admin.Leases(c.Request.Context(), repo.LeaseFilter{
		UID:      uid,
		States:   parseCSV(c.Query("state")),
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewLeaseAdminPage(result))
}

// adminReleaseLease force-reclaims a lease (204, idempotent on terminal leases).
func adminReleaseLease(c *gin.Context, d Deps) {
	if err := d.Admin.ReleaseLease(c.Request.Context(), c.Param("id"), currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
