// Package router: self-service password change for the logged-in console
// user (the admin "账户" page remains the override path for OTHER accounts).
// Requires the current password — a hijacked session alone cannot take over
// the credential permanently.
package router

import (
	"log/slog"
	"net/http"

	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
)

func (r *Router) pagePasswordSelf(c *gin.Context) {
	s, ok := currentUser(c)
	if !ok {
		c.Redirect(http.StatusFound, "/login")
		return
	}
	renderPage(c.Writer, "password", struct {
		BaseData
		Username string
	}{
		BaseData: newBase(c, "", "修改密码", ""),
		Username: s.Username,
	})
}

func (r *Router) handlePasswordSelf(c *gin.Context) {
	s, ok := currentUser(c)
	if !ok {
		c.Redirect(http.StatusFound, "/login")
		return
	}
	back := "/console/password"
	oldPwd := c.PostForm("old_password")
	newPwd := c.PostForm("new_password")
	newPwd2 := c.PostForm("new_password2")

	if _, ok := r.consoleAuth.verifyUser(s.Username, oldPwd); !ok {
		redirectFlash(c, back, "err", "当前密码不正确")
		return
	}
	if len(newPwd) < 8 || len(newPwd) > 128 {
		redirectFlash(c, back, "err", "新密码需 8–128 位")
		return
	}
	if newPwd != newPwd2 {
		redirectFlash(c, back, "err", "两次输入的新密码不一致")
		return
	}
	if newPwd == oldPwd {
		redirectFlash(c, back, "err", "新密码不能与当前密码相同")
		return
	}
	uid, err := resolveUserID(s.UserID)
	if err != nil {
		redirectFlash(c, back, "err", "账户不存在：%v", err)
		return
	}
	if err := repo.SetUserPassword(uid, newPwd); err != nil {
		redirectFlash(c, back, "err", "修改失败：%v", err)
		return
	}
	slog.Info("[AUTH] self password change", "username", s.Username, "ip", c.ClientIP())
	redirectFlash(c, back, "ok", "密码已更新")
}
