package middleware

import (
	"net/http"
	"strings"

	"app-cloud/internal/config"

	"github.com/gin-gonic/gin"
)

// SecurityHeaders sets the baseline response headers for every route.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "SAMEORIGIN") // SAMEORIGIN: presigned previews render in-app
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// CORS applies the exact-origin allowlist and answers preflight locally.
func CORS(cfg *config.Config) gin.HandlerFunc {
	allowed := make(map[string]bool)
	if cfg != nil {
		for _, o := range cfg.CORS.AllowOrigins {
			allowed[strings.TrimSpace(o)] = true
		}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, If-Match, X-Fp, X-Ticket")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
