// Package middleware contains the app-cloud Gin middleware chain: identity,
// M2M credentials, capability gates and response security. Handlers never
// parse these concerns themselves.
package middleware

import (
	"net/http"
	"strconv"
	"strings"

	"app-cloud/internal/dto"

	"github.com/gin-gonic/gin"
)

// uidContextKey is the request-context slot populated by RequireUID /
// RequireInternalUID; handlers read it through UIDFrom.
const uidContextKey = "cloud.uid"

// RequireUID authenticates the gateway-injected X-Uid once for every owner
// route under /cloud and /workspaces. Missing/invalid identity aborts the
// chain with 401; handlers can assume a valid uid.
func RequireUID() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := strings.TrimSpace(c.Request.Header.Get("X-Uid"))
		if raw == "" {
			writeError(c, http.StatusUnauthorized, "未提供认证 token")
			c.Abort()
			return
		}
		uid, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || uid <= 0 {
			writeError(c, http.StatusUnauthorized, "token 无效或已过期")
			c.Abort()
			return
		}
		c.Set(uidContextKey, uid)
		c.Next()
	}
}

// UIDFrom returns the authenticated uid stored by the identity middleware.
func UIDFrom(c *gin.Context) int64 {
	v, _ := c.Get(uidContextKey)
	uid, _ := v.(int64)
	return uid
}

// RequireInternalUID validates the explicit ?uid= of an M2M call and stores it
// in the same context slot as owner routes. The apikey middleware already
// authenticated the calling service, so this is validation rather than trust.
func RequireInternalUID() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := strings.TrimSpace(c.Query("uid"))
		if raw == "" {
			writeError(c, http.StatusUnprocessableEntity, "缺少 uid 参数")
			c.Abort()
			return
		}
		uid, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || uid <= 0 {
			writeError(c, http.StatusUnprocessableEntity, "uid 不合法")
			c.Abort()
			return
		}
		c.Set(uidContextKey, uid)
		c.Next()
	}
}

func writeError(c *gin.Context, status int, detail string) {
	c.JSON(status, dto.ErrorResponse{Detail: detail})
}
