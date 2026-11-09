// Internal M2M user lookup for the AI stack (app-ts): GET /internal/auth/user/{uid}
// returns the profile fields the task-quiz flow needs (email for quiz delivery).
// Guard = shared apikey (APISIX consumer key), mirroring app-user's /internal/bili
// convention. Never exposed through nginx.
package router

import (
	"net/http"
	"strconv"

	authdto "app-user/internal/dto/auth"
	"app-user/internal/router/middleware"

	"github.com/gin-gonic/gin"
)

func registerInternalUser(e *gin.Engine, d Deps) {
	g := e.Group("/internal/auth", middleware.APIKey(d.Cfg.Internal.APIKey))

	// GET /internal/auth/user/{uid} — email/status lookup (task-quiz delivery).
	g.GET("/user/:uid", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		email, status, ok, err := d.Auth.InternalUserContact(uid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "内部错误"})
			return
		}
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"detail": "用户不存在"})
			return
		}
		c.JSON(http.StatusOK, authdto.InternalUser{UID: uid, Email: email, Status: status})
	})

	// Coding Plan M2M lookup moved to the settings listener:
	// GET /internal/settings/coding-plan/{uid} (internal/router/settings).
}
