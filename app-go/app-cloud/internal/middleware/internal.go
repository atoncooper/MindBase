package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"app-cloud/internal/config"

	"github.com/gin-gonic/gin"
)

// RequireInternalKey gates the M2M endpoints on the shared internal.api_key.
// Fail closed when the key is unconfigured (503); a configured key must match
// exactly (constant-time) or the request is rejected as 401.
func RequireInternalKey(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		expected := ""
		if cfg != nil {
			expected = strings.TrimSpace(cfg.Internal.APIKey)
		}
		if expected == "" {
			writeError(c, http.StatusServiceUnavailable, "internal api disabled")
			c.Abort()
			return
		}
		provided := strings.TrimSpace(c.GetHeader("apikey"))
		if provided == "" {
			provided = strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		}
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			writeError(c, http.StatusUnauthorized, "invalid apikey")
			c.Abort()
			return
		}
		c.Next()
	}
}
