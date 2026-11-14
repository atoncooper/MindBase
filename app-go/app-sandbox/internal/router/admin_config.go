package router

import (
	"net/http"

	"app-sandbox/internal/dto"

	"github.com/gin-gonic/gin"
)

// adminConfig returns the read-only runtime configuration (never secrets).
func adminConfig(c *gin.Context, d Deps) {
	c.JSON(http.StatusOK, dto.NewAdminRuntimeConfigView(d.Cfg))
}
