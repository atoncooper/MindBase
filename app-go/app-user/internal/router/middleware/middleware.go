// Package middleware holds the shared HTTP security middleware used by the
// three app-user engines. Keeping it in one place makes the security stance
// auditable: recovery, access log, request id, security headers, CORS and the
// constant-time M2M apikey guard.
package middleware

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"app-user/internal/infra/metrics"
	"app-user/internal/logger"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Recovery turns panics into 500 responses and logs them.
func Recovery() gin.HandlerFunc { return logger.GinRecovery() }

// AccessLog emits one structured access-log line per request.
func AccessLog() gin.HandlerFunc { return logger.GinLogger() }

// SecurityHeaders sets conservative defaults on every response.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// Metrics records one latency sample per request against the process-wide
// histogram, labelled by Gin route pattern (bounded cardinality) and service.
// It must sit early in the chain so the sample covers the handler and the
// downstream middlewares.
func Metrics(service string) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		metrics.Default.Observe(metrics.Labels{Service: service, Route: route}, time.Since(start))
	}
}

// RequestID propagates the gateway-generated request id (APISIX request-id
// plugin) or mints one; access logs carry it for trail correlation.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader("X-Request-Id"))
		if id == "" {
			id = strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		}
		if len(id) > 64 {
			id = id[:64]
		}
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

// BodyLimit caps the request body size. http.MaxBytesReader makes reads past
// maxBytes fail and the handler respond 413; it is wired per engine so a
// compromised/buggy client cannot stream unbounded JSON into memory.
func BodyLimit(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}

// CORS echoes whitelisted origins (empty list = only swallow OPTIONS).
func CORS(allowOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, o := range allowOrigins {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = true
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

// APIKey guards the internal M2M faces with the shared APISIX consumer key.
// Both sides are hashed and compared in constant time; an unconfigured
// expected key rejects everything (fail-closed).
func APIKey(expected string) gin.HandlerFunc {
	expectedHash := sha256.Sum256([]byte(expected))
	return func(c *gin.Context) {
		provided := sha256.Sum256([]byte(strings.TrimSpace(c.GetHeader("apikey"))))
		if expected == "" || subtle.ConstantTimeCompare(provided[:], expectedHash[:]) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "invalid api key"})
			return
		}
		c.Next()
	}
}
