// Package router: console account management (payadmin_user, admin only).
package router

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

func (r *Router) apiListUsers(c *gin.Context) {
	us, err := repo.ListUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(us))
	for _, u := range us {
		out = append(out, gin.H{
			"id":         u.ID,
			"username":   u.Username,
			"role":       u.Role,
			"created_at": u.CreatedAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"users": out})
}

func (r *Router) apiCreateUser(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required,min=2,max=64"`
		Password string `json:"password" binding:"required,min=8,max=128"`
		Role     string `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	if req.Role == "" {
		req.Role = repo.RoleViewer
	}
	if req.Role != repo.RoleAdmin && req.Role != repo.RoleViewer {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "role must be admin or viewer"})
		return
	}
	u, err := repo.CreateUser(req.Username, req.Password, req.Role)
	if err == repo.ErrUserExists {
		c.JSON(http.StatusConflict, gin.H{"detail": "username already exists"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "create user failed: " + err.Error()})
		return
	}
	slog.Info("[USER] created", "operator", operatorOf(c), "username", u.Username, "role", u.Role)
	c.JSON(http.StatusOK, gin.H{"id": u.ID, "username": u.Username, "role": u.Role})
}

func (r *Router) apiSetUserPassword(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid user id"})
		return
	}
	var req struct {
		Password string `json:"password" binding:"required,min=8,max=128"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	if err := repo.SetUserPassword(id, req.Password); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": err.Error()})
		return
	}
	slog.Info("[USER] password changed", "operator", operatorOf(c), "user_id", id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (r *Router) apiDeleteUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid user id"})
		return
	}
	me, ok := currentUser(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "unauthorized"})
		return
	}
	if me.UserID == id {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "cannot delete your own account"})
		return
	}
	target, err := repo.GetUserByID(id)
	if err != nil || target == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "user not found"})
		return
	}
	if target.Role == repo.RoleAdmin {
		admins, _ := repo.CountUsersByRole(repo.RoleAdmin)
		if admins <= 1 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "cannot delete the last admin"})
			return
		}
	}
	if err := repo.DeleteUser(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	slog.Info("[USER] deleted", "operator", me.Username, "username", target.Username)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
