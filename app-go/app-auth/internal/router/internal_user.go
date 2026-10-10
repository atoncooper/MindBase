// Internal M2M user lookup for the AI stack (app-ts): GET /internal/auth/user/{uid}
// returns the profile fields the task-quiz flow needs (email for quiz delivery).
// Guard = shared apikey (APISIX consumer key), mirroring app-bili's /internal/bili
// convention. Never exposed through nginx.
package router

import (
	"net/http"
	"strconv"
	"strings"

	"app-auth/internal/db"
	"app-auth/internal/model"

	"github.com/gin-gonic/gin"
)

func registerInternalUser(e *gin.Engine, d Deps) {
	guard := func(c *gin.Context) {
		key := strings.TrimSpace(c.GetHeader("apikey"))
		if key == "" || key != d.Cfg.Internal.APIKey {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "invalid api key"})
			c.Abort()
			return
		}
		c.Next()
	}

	g := e.Group("/internal/auth", guard)

	// GET /internal/auth/user/{uid} — email/status lookup (task-quiz delivery).
	g.GET("/user/:uid", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		var user model.User
		if err := db.DB.WithContext(c.Request.Context()).
			Select("uid", "email", "status", "deleted_at").
			Where("uid = ?", uid).First(&user).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "用户不存在"})
			return
		}
		email := ""
		if user.Email != nil {
			email = *user.Email
		}
		status := ""
		if user.Status != nil {
			status = *user.Status
		}
		c.JSON(http.StatusOK, gin.H{"uid": uid, "email": email, "status": status})
	})
}
