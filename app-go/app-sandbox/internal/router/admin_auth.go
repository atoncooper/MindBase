package router

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"app-sandbox/internal/config"
	"app-sandbox/internal/dto"

	"github.com/gin-gonic/gin"
)

// adminTokenAuth enforces the shared admin token (constant-time compare).
// Unconfigured token -> 503 {"detail":"admin api disabled"}; wrong/missing
// token -> 401 {"detail":...}.
func adminTokenAuth(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		expected := strings.TrimSpace(cfg.Admin.Token)
		if expected == "" {
			c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "admin api disabled"})
			c.Abort()
			return
		}
		provided := strings.TrimSpace(c.GetHeader("X-Admin-Token"))
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			apiErr(c, http.StatusUnauthorized, "未授权")
			c.Abort()
			return
		}
		c.Next()
	}
}
