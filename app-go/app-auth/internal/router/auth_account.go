package router

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
)

// getMe — GET /auth/me.
func getMe(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		info, err := d.Auth.GetUserByUID(uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if info == nil {
			apiErr(c, http.StatusNotFound, "用户不存在")
			return
		}
		roles := info.Roles
		if len(roles) == 0 {
			roles = []string{"free"}
		}
		c.JSON(http.StatusOK, gin.H{
			"uid":      info.UID,
			"nickname": info.Nickname,
			"avatar":   info.Avatar,
			"status":   info.Status,
			"roles":    roles,
		})
	}
}

// logoutCurrent — DELETE /auth/token (revoke the presented token).
func logoutCurrent(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			apiErr(c, http.StatusBadRequest, "未提供 token")
			return
		}
		if err := d.Tokens.Revoke(c.Request.Context(), token); err != nil {
			slog.Error("[AUTH] logout failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "已退出登录"})
	}
}

// logoutAll — DELETE /auth/tokens (revoke every session of the caller).
func logoutAll(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		if err := d.Tokens.RevokeAllForUser(c.Request.Context(), uid); err != nil {
			slog.Error("[AUTH] logout-all failed", "uid", uid, "err", err)
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "已退出所有设备"})
	}
}

// listSessions — GET /auth/tokens (active sessions, is_current marked).
func listSessions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		token := currentToken(c)
		rows, err := d.Tokens.ListActive(uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		sessions := make([]gin.H, 0, len(rows))
		for _, t := range rows {
			sessions = append(sessions, gin.H{
				"session_token":  t.SessionToken,
				"device_id":      t.DeviceID,
				"ip":             t.IP,
				"user_agent":     t.UserAgent,
				"created_at":     t.CreatedAt,
				"last_active_at": t.LastActiveAt,
				"expires_at":     t.ExpiresAt,
				"is_current":     t.SessionToken == token,
			})
		}
		c.JSON(http.StatusOK, gin.H{"sessions": sessions})
	}
}

// revokeSession — DELETE /auth/tokens/{session_token} (ownership-checked).
func revokeSession(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		target := c.Param("session_token")
		ok, err := d.Tokens.RevokeOwned(c.Request.Context(), uid, target)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if !ok {
			apiErr(c, http.StatusNotFound, "会话不存在或已失效")
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "已退出该设备"})
	}
}

// getProfile — GET /auth/profile.
func getProfile(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		p, err := d.Auth.GetFullProfile(uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if p == nil {
			apiErr(c, http.StatusNotFound, "用户不存在")
			return
		}
		c.JSON(http.StatusOK, p)
	}
}

// updateProfile — PATCH /auth/profile (all fields optional).
func updateProfile(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var body map[string]any
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		p, err := d.Auth.UpdateProfile(uid, body)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if p == nil {
			apiErr(c, http.StatusNotFound, "用户不存在")
			return
		}
		c.JSON(http.StatusOK, p)
	}
}

// setPassword — POST /auth/password/set (first-time, mandatory 2nd factor).
func setPassword(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Password  string  `json:"password" binding:"required"`
		EmailCode *string `json:"email_code"`
		SMSCode   *string `json:"sms_code"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		if !rlKey(d, c, "pw_set_uid", "uid:"+strconv.FormatInt(uid, 10)) {
			return
		}
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		emailCode, smsCode := "", ""
		if req.EmailCode != nil {
			emailCode = *req.EmailCode
		}
		if req.SMSCode != nil {
			smsCode = *req.SMSCode
		}
		if err := d.Verification.VerifyAndSetPassword(uid, req.Password, emailCode, smsCode); err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				apiErr(c, http.StatusNotFound, err.Error())
				return
			}
			slog.Warn("[AUTH] set_password failed", "uid", uid, "err", err)
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "密码设置成功"})
	}
}

// changePassword — PATCH /auth/password (old password + optional email 2FA).
func changePassword(d Deps) gin.HandlerFunc {
	type reqBody struct {
		OldPassword string  `json:"old_password" binding:"required"`
		NewPassword string  `json:"new_password" binding:"required"`
		EmailCode   *string `json:"email_code"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		if !rlKey(d, c, "pw_change_uid", "uid:"+strconv.FormatInt(uid, 10)) {
			return
		}
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		emailCode := ""
		if req.EmailCode != nil {
			emailCode = *req.EmailCode
		}
		if err := d.Verification.VerifyAndChangePassword(uid, req.OldPassword, req.NewPassword, emailCode); err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				apiErr(c, http.StatusNotFound, err.Error())
				return
			}
			slog.Warn("[AUTH] change_password failed", "uid", uid, "err", err)
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "密码修改成功"})
	}
}

// bindEmail — PUT /auth/email (direct bind, unverified).
func bindEmail(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Email string `json:"email" binding:"required"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := d.Auth.BindEmail(uid, email); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "邮箱绑定成功", "email": email})
	}
}

// unbindEmail — DELETE /auth/email.
func unbindEmail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		if err := d.Auth.UnbindEmail(uid); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "邮箱已解绑"})
	}
}

// emailSendCode — POST /auth/email/send-code (bind_email | twofa).
func emailSendCode(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Email       string  `json:"email" binding:"required"`
		Purpose     string  `json:"purpose"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		purpose := req.Purpose
		if purpose == "" {
			purpose = "bind_email"
		}
		if purpose != "bind_email" && purpose != "twofa" {
			apiErr(c, http.StatusUnprocessableEntity, "purpose 必须为 bind_email 或 twofa")
			return
		}
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "email_send_code") {
			return
		}
		if !rlIP(d, c, "email_send_ip") {
			return
		}
		if !rlKey(d, c, "email_send_uid", "uid:"+strconv.FormatInt(uid, 10)) {
			return
		}
		if err := d.Verification.SendCode(c.Request.Context(), uid, email, purpose); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "验证码已发送"})
	}
}

// emailVerify — POST /auth/email/verify (bind on bind_email; check-only on twofa).
func emailVerify(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Email   string `json:"email" binding:"required"`
		Code    string `json:"code" binding:"required"`
		Purpose string `json:"purpose"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		purpose := req.Purpose
		if purpose == "" {
			purpose = "bind_email"
		}
		if purpose != "bind_email" && purpose != "twofa" {
			apiErr(c, http.StatusUnprocessableEntity, "purpose 必须为 bind_email 或 twofa")
			return
		}
		if err := d.Verification.VerifyAndBindEmail(uid, email, strings.TrimSpace(req.Code), purpose); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "验证成功", "email": email, "purpose": purpose})
	}
}

// bindPhone — PUT /auth/phone (direct bind, unverified).
func bindPhone(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Phone string `json:"phone" binding:"required"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := service.NormalizePhoneExported(req.Phone)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := d.Auth.BindPhone(uid, phone); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "手机号绑定成功", "phone": phone})
	}
}

// unbindPhone — DELETE /auth/phone.
func unbindPhone(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		if err := d.Auth.UnbindPhone(uid); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "手机号已解绑"})
	}
}

// phoneVerify — POST /auth/phone/verify (verify SMS code and bind).
func phoneVerify(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Phone string `json:"phone" binding:"required"`
		Code  string `json:"code" binding:"required"`
	}
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := service.NormalizePhoneExported(req.Phone)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := d.Verification.VerifyAndBindPhone(uid, phone, strings.TrimSpace(req.Code)); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "手机号验证成功", "phone": phone})
	}
}

// listDevices — GET /auth/devices.
func listDevices(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		rows, err := d.Auth.ListDevices(uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		devices := make([]gin.H, 0, len(rows))
		for _, dv := range rows {
			devices = append(devices, gin.H{
				"device_id":       dv.DeviceID,
				"device_type":     dv.DeviceType,
				"device_name":     dv.DeviceName,
				"os":              dv.OS,
				"os_version":      dv.OSVersion,
				"browser":         dv.Browser,
				"browser_version": dv.BrowserVersion,
				"trust_level":     dv.TrustLevel,
				"last_active_at":  dv.LastActiveAt,
				"created_at":      dv.CreatedAt,
				"is_current":      false,
			})
		}
		c.JSON(http.StatusOK, gin.H{"devices": devices})
	}
}

// getSecurity — GET /auth/security.
func getSecurity(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		info, err := d.Auth.GetSecurityInfo(uid, d.Passport)
		if err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				apiErr(c, http.StatusNotFound, err.Error())
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, info)
	}
}
