// Package router: console account page + form submits (admin only).
package router

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

type userRow struct {
	ID        int64
	Username  string
	Role      string
	IsAdmin   bool
	CreatedAt string
	Deletable bool
}

func requireAdminPage(c *gin.Context) (webuiSession, bool) {
	s, ok := currentUser(c)
	if !ok || s.Role != repo.RoleAdmin {
		redirectFlash(c, "/orders", "err", "需要 admin 角色")
		return s, false
	}
	return s, true
}

func (r *Router) pageUsers(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	us, err := repo.ListUsers()
	if err != nil {
		slog.Error("[PAGE] list users failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	admins, _ := repo.CountUsersByRole(repo.RoleAdmin)
	items := make([]userRow, 0, len(us))
	for _, u := range us {
		deletable := u.ID != s.UserID
		if u.Role == repo.RoleAdmin && admins <= 1 {
			deletable = false // 最后一个 admin 不可删
		}
		items = append(items, userRow{
			ID:        u.ID,
			Username:  u.Username,
			Role:      u.Role,
			IsAdmin:   u.Role == repo.RoleAdmin,
			CreatedAt: fmtTime(u.CreatedAt),
			Deletable: deletable,
		})
	}
	renderPage(c.Writer, "users", struct {
		BaseData
		Items []userRow
	}{
		BaseData: newBase(c, "users", "账户", "控制台账户与角色管理（payadmin_user，仅 admin 可见）"),
		Items:    items,
	})
}

func (r *Router) handleUserCreate(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	username := strings.TrimSpace(c.PostForm("username"))
	password := c.PostForm("password")
	role := c.PostForm("role")
	if len(username) < 2 || len(username) > 64 {
		redirectFlash(c, "/users", "err", "用户名需 2–64 字符")
		return
	}
	if len(password) < 8 || len(password) > 128 {
		redirectFlash(c, "/users", "err", "密码需 8–128 位")
		return
	}
	if role == "" {
		role = repo.RoleViewer
	}
	if role != repo.RoleAdmin && role != repo.RoleViewer {
		redirectFlash(c, "/users", "err", "角色必须是 admin 或 viewer")
		return
	}
	u, err := repo.CreateUser(username, password, role)
	if err == repo.ErrUserExists {
		redirectFlash(c, "/users", "err", "用户名已存在：%s", username)
		return
	}
	if err != nil {
		slog.Error("[USER] create failed", "err", err, "operator", s.Username)
		redirectFlash(c, "/users", "err", "创建失败：%v", err)
		return
	}
	slog.Info("[USER] created", "operator", s.Username, "username", u.Username, "role", u.Role)
	redirectFlash(c, "/users", "ok", "账户已创建：%s（%s）", u.Username, u.Role)
}

func (r *Router) handleUserPassword(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		redirectFlash(c, "/users", "err", "user id 不合法")
		return
	}
	password := c.PostForm("password")
	if len(password) < 8 || len(password) > 128 {
		redirectFlash(c, "/users", "err", "密码需 8–128 位")
		return
	}
	if err := repo.SetUserPassword(id, password); err != nil {
		redirectFlash(c, "/users", "err", "改密失败：%v", err)
		return
	}
	slog.Info("[USER] password changed", "operator", s.Username, "user_id", id)
	redirectFlash(c, "/users", "ok", "密码已更新")
}

func (r *Router) handleUserDelete(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		redirectFlash(c, "/users", "err", "user id 不合法")
		return
	}
	if id == s.UserID {
		redirectFlash(c, "/users", "err", "不能删除自己的账户")
		return
	}
	target, err := repo.GetUserByID(id)
	if err != nil || target == nil {
		redirectFlash(c, "/users", "err", "账户不存在")
		return
	}
	if target.Role == repo.RoleAdmin {
		admins, _ := repo.CountUsersByRole(repo.RoleAdmin)
		if admins <= 1 {
			redirectFlash(c, "/users", "err", "不能删除最后一个 admin")
			return
		}
	}
	if err := repo.DeleteUser(id); err != nil {
		redirectFlash(c, "/users", "err", "删除失败：%v", err)
		return
	}
	slog.Info("[USER] deleted", "operator", s.Username, "username", target.Username)
	redirectFlash(c, "/users", "ok", "账户已删除：%s", target.Username)
}
