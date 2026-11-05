package middleware

import (
	"strconv"
	"time"

	"app-cloud/internal/metrics"

	"github.com/gin-gonic/gin"
)

// Metrics records the HTTP golden signals. The route label is the registered
// pattern (c.FullPath) so path parameters cannot explode label cardinality;
// unmatched paths collapse to UNMATCHED.
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "UNMATCHED"
		}
		metrics.HTTPRequests.WithLabelValues(c.Request.Method, route, strconv.Itoa(c.Writer.Status())).Inc()
		metrics.HTTPDuration.WithLabelValues(c.Request.Method, route).Observe(time.Since(start).Seconds())
	}
}
