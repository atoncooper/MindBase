package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RequireCapability turns an optional wired service into a route-level gate:
// false means the capability is unavailable (503) before handler logic runs.
func RequireCapability(available bool, detail string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !available {
			writeError(c, http.StatusServiceUnavailable, detail)
			c.Abort()
			return
		}
		c.Next()
	}
}
