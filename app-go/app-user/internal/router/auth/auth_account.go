package router

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	authdto "app-user/internal/dto/auth"
	"app-user/internal/service/auth"

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
		c.JSON(http.StatusOK, authdto.UserInfo{
			UID:      info.UID,
			Nickname: info.Nickname,
			Avatar:   info.Avatar,
			Status:   info.Status,
			Roles:    roles,
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
		c.JSON(http.StatusOK, authdto.Message{Message: "已退出登录"})
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
		c.JSON(http.StatusOK, authdto.Message{Message: "已退出所有设备"})
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
		sessions := make([]authdto.Session, 0, len(rows))
		for _, t := range rows {
			sessions = append(sessions, authdto.Session{
				SessionID:    service.SessionID(t.SessionToken),
				DeviceID:     t.DeviceID,
				IP:           t.IP,
				UserAgent:    t.UserAgent,
				CreatedAt:    t.CreatedAt,
				LastActiveAt: t.LastActiveAt,
				ExpiresAt:    t.ExpiresAt,
				IsCurrent:    t.SessionToken == token,
			})
		}
		c.JSON(http.StatusOK, authdto.Sessions{Sessions: sessions})
	}
}

// revokeSession — DELETE /auth/tokens/{session_token} (ownership-checked).
func revokeSession(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		target := c.Param("session_id")
		ok, err := d.Tokens.RevokeBySessionID(c.Request.Context(), uid, target)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if !ok {
			apiErr(c, http.StatusNotFound, "会话不存在或已失效")
			return
		}
		c.JSON(http.StatusOK, authdto.Message{Message: "已退出该设备"})
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
	return func(c *gin.Context) {
		uid := currentUID(c)
		if !rlKey(d, c, "pw_set_uid", "uid:"+strconv.FormatInt(uid, 10)) {
			return
		}
		var req authdto.SetPasswordRequest
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
		c.JSON(http.StatusOK, authdto.Message{Message: "密码设置成功"})
	}
}

// changePassword — PATCH /auth/password (old password + optional email 2FA).
// The mandatory second-factor workflow lives in Verification; this handler
// keeps only the per-uid guard and the post-change session rotation.
func changePassword(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		if !rlKey(d, c, "pw_change_uid", "uid:"+strconv.FormatInt(uid, 10)) {
			return
		}
		var req authdto.ChangePasswordRequest
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
		if err := d.Verification.VerifyAndChangePassword(uid, req.OldPassword, req.NewPassword, emailCode, smsCode); err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				apiErr(c, http.StatusNotFound, err.Error())
				return
			}
			slog.Warn("[AUTH] change_password failed", "uid", uid, "err", err)
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		// Keep the current device signed in, cut every other session.
		otherSessionsRevoked := true
		if err := d.Tokens.RevokeOthersForUser(c.Request.Context(), uid, currentToken(c)); err != nil {
			otherSessionsRevoked = false
			slog.Error("[AUTH] revoke other sessions failed", "uid", uid, "err", err)
		}
		c.JSON(http.StatusOK, authdto.ChangePassword{
			Message:              "密码修改成功",
			OtherSessionsRevoked: otherSessionsRevoked,
		})
	}
}

// bindEmail — PUT /auth/email (direct bind, unverified).
func bindEmail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req authdto.BindEmailRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := d.Verification.BindEmailDirect(uid, req.Email, req.CurrentPassword)
		if err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.BindEmail{Message: "邮箱绑定成功", Email: email})
	}
}

// unbindEmail — DELETE /auth/email.
func unbindEmail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		if err := d.Verification.UnbindEmailAccount(uid); err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.Message{Message: "邮箱已解绑"})
	}
}

// emailSendCode — POST /auth/email/send-code (bind_email | twofa).
func emailSendCode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req authdto.EmailSendCodeRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		plan, err := d.Verification.PlanEmailSendCode(uid, req.Email, req.Purpose)
		if err != nil {
			apiFlowErr(c, err)
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
		if err := d.Verification.SendCode(c.Request.Context(), plan.UID, plan.Target, plan.Purpose); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, authdto.Message{Message: "验证码已发送"})
	}
}

// emailVerify — POST /auth/email/verify (bind on bind_email; check-only on twofa).
func emailVerify(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req authdto.EmailVerifyRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, purpose, err := d.Verification.BindEmailVerified(uid, req.Email, req.Code, req.Purpose, req.CurrentPassword)
		if err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.VerifyEmail{Message: "验证成功", Email: email, Purpose: purpose})
	}
}

// bindPhone — PUT /auth/phone (direct bind, unverified). Allowed only when
// SMS is not configured; otherwise callers must use /auth/phone/verify.
func bindPhone(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		// When SMS is configured, binding MUST be verified by code; the direct
		// path would otherwise let a caller store an unverified number.
		if d.Cfg.SMS.Configured() {
			apiErr(c, http.StatusForbidden, service.ErrSMSBindingRequiresCode.Error())
			return
		}
		var req authdto.BindPhoneRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := d.Verification.BindPhoneDirect(uid, req.Phone, req.CurrentPassword)
		if err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.BindPhone{Message: "手机号绑定成功", Phone: phone})
	}
}

// unbindPhone — DELETE /auth/phone. Security-sensitive: requires either a
// valid SMS code sent to the currently bound phone (purpose=unbind) or the
// account password (step-up). A bare DELETE with nothing is rejected.
func unbindPhone(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req authdto.UnbindPhoneRequest
		if c.Request.Body != nil {
			if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
				apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
				return
			}
		}
		if err := d.Verification.UnbindPhoneAccount(uid, req.Code, req.CurrentPassword); err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.Message{Message: "手机号已解绑"})
	}
}

// phoneVerify — POST /auth/phone/verify (verify SMS code and bind).
func phoneVerify(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := currentUID(c)
		var req authdto.PhoneVerifyRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := d.Verification.BindPhoneVerified(uid, req.Phone, req.Code, req.CurrentPassword)
		if err != nil {
			apiFlowErr(c, err)
			return
		}
		c.JSON(http.StatusOK, authdto.BindPhone{Message: "手机号验证成功", Phone: phone})
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
		devices := make([]authdto.Device, 0, len(rows))
		for _, dv := range rows {
			devices = append(devices, authdto.Device{
				DeviceID:       dv.DeviceID,
				DeviceType:     dv.DeviceType,
				DeviceName:     dv.DeviceName,
				OS:             dv.OS,
				OSVersion:      dv.OSVersion,
				Browser:        dv.Browser,
				BrowserVersion: dv.BrowserVersion,
				TrustLevel:     dv.TrustLevel,
				LastActiveAt:   dv.LastActiveAt,
				CreatedAt:      dv.CreatedAt,
				IsCurrent:      false,
			})
		}
		c.JSON(http.StatusOK, authdto.Devices{Devices: devices})
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
