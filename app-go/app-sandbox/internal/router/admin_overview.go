package router

import (
	"net/http"

	"app-sandbox/internal/dto"

	"github.com/gin-gonic/gin"
)

// adminOverview returns the aggregate state counts for the admin dashboard.
func adminOverview(c *gin.Context, d Deps) {
	counts, err := d.Admin.Overview(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewOverviewView(counts, d.Cfg.Quota.Enabled))
}
