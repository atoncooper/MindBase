// Console account management endpoints: /api/console/users.
//
// Deliberately separate from GET /api/users (the read-only BUSINESS user
// lookup) — these accounts are the admin console's own admin_user rows. All
// four routes are admin-only; the module never touches the payment database,
// so it keeps working when app_pay is disabled.
package router

import (
	"errors"
	"net/http"
	"strconv"

	"app-admin/internal/repo"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

// registerConsoleUserRoutes mounts /api/console/users behind requireAdmin.
func (r *Router) registerConsoleUserRoutes(api *gin.RouterGroup) {
	group := api.Group("/console/users", requireAdmin())
	group.GET("", r.apiConsoleListUsers)
	group.POST("", r.apiConsoleCreateUser)
	group.POST("/:id/password", r.apiConsoleResetPassword)
	group.DELETE("/:id", r.apiConsoleDeleteUser)
}

// apiConsoleListUsers GET /api/console/users — every account, username ASC.
func (r *Router) apiConsoleListUsers(c *gin.Context) {
	result, err := r.console.List()
	if err != nil {
		serverError(c, err, "console users")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiConsoleCreateUser POST /api/console/users
// body {"username":2..64,"password":8..128,"role"?:"admin"|"viewer"}.
func (r *Router) apiConsoleCreateUser(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		detail(c, http.StatusBadRequest, "json body with username/password required")
		return
	}
	actor := operatorOf(c)
	result, err := r.console.Create(actor, req.Username, req.Password, req.Role)
	if err != nil {
		switch {
		case errors.Is(err, repo.ErrUserExists):
			detail(c, http.StatusConflict, "username already exists")
		case errors.Is(err, service.ErrConsoleInvalidUsername),
			errors.Is(err, service.ErrConsoleInvalidPassword),
			errors.Is(err, service.ErrConsolePasswordTooLong),
			errors.Is(err, service.ErrConsoleInvalidRole):
			detail(c, http.StatusBadRequest, err.Error())
		default:
			serverError(c, err, "console user create")
		}
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiConsoleResetPassword POST /api/console/users/:id/password
// body {"password":8..128}. Forces a password change on next login and drops
// every session of that account.
func (r *Router) apiConsoleResetPassword(c *gin.Context) {
	id, ok := consoleUserID(c)
	if !ok {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		detail(c, http.StatusBadRequest, "json body with password required")
		return
	}
	if err := r.console.ResetPassword(operatorOf(c), id, req.Password); err != nil {
		switch {
		case errors.Is(err, repo.ErrUserNotFound):
			detail(c, http.StatusNotFound, "user not found")
		case errors.Is(err, service.ErrConsoleInvalidPassword),
			errors.Is(err, service.ErrConsolePasswordTooLong):
			detail(c, http.StatusBadRequest, err.Error())
		default:
			serverError(c, err, "console user password reset")
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// apiConsoleDeleteUser DELETE /api/console/users/:id — refuses self-deletion
// and deletion of the last admin; also drops the target's sessions.
func (r *Router) apiConsoleDeleteUser(c *gin.Context) {
	id, ok := consoleUserID(c)
	if !ok {
		return
	}
	me, ok := identityOf(c)
	if !ok {
		detail(c, http.StatusUnauthorized, "login required")
		return
	}
	if err := r.console.Delete(me.UserID, me.Username, id); err != nil {
		switch {
		case errors.Is(err, repo.ErrUserNotFound):
			detail(c, http.StatusNotFound, "user not found")
		case errors.Is(err, service.ErrCannotDeleteSelf),
			errors.Is(err, service.ErrLastAdmin):
			detail(c, http.StatusBadRequest, err.Error())
		default:
			serverError(c, err, "console user delete")
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// consoleUserID parses the :id path segment (admin_user auto-increment id).
func consoleUserID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		detail(c, http.StatusBadRequest, "invalid user id")
		return 0, false
	}
	return id, true
}
