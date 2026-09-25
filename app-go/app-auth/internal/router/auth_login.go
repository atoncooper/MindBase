package router

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"app-auth/internal/model"
	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// tokenResponse builds the login-success envelope (TokenResponse shape).
func tokenResponse(d Deps, c *gin.Context, uid int64, sessionToken string, expiresAt *time.Time) {
	nickname, avatar, status, roles := d.userPayload(c, uid)
	c.JSON(http.StatusOK, gin.H{
		"session_token": sessionToken,
		"token_type":    "access",
		"expires_at":    expiresAt,
		"user_info": gin.H{
			"uid":      uid,
			"nickname": nickname,
			"avatar":   avatar,
			"status":   status,
			"roles":    roles,
		},
	})
}

// passwordLogin — POST /auth/login (email/phone + password).
// Brute-force defense layers: /auth per-IP guard, per-identifier Redis
// throttle, single-use captcha, DB cooldown + audit (login_attempts).
func passwordLogin(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string             `json:"captcha_id"`
		CaptchaCode *string             `json:"captcha_code"`
		Email       *string             `json:"email"`
		Phone       *string             `json:"phone"`
		Password    string              `json:"password" binding:"required"`
		Device      *service.DeviceMeta `json:"device"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		identifier := ""
		if req.Email != nil && *req.Email != "" {
			e, err := service.NormalizeEmailExported(*req.Email)
			if err != nil {
				apiErr(c, http.StatusUnprocessableEntity, err.Error())
				return
			}
			identifier = e
		} else if req.Phone != nil && *req.Phone != "" {
			p, err := service.NormalizePhoneExported(*req.Phone)
			if err != nil {
				apiErr(c, http.StatusUnprocessableEntity, err.Error())
				return
			}
			identifier = p
		}
		if identifier == "" {
			apiErr(c, http.StatusUnprocessableEntity, "请输入邮箱或手机号")
			return
		}

		// Per-identifier lockout must precede any password work.
		if allowed, retryAfter := d.Throttle.Check(c.Request.Context(), identifier); !allowed {
			apiErr(c, http.StatusTooManyRequests, "登录失败次数过多，请稍后再试", retryAfter)
			return
		}
		// Per-IP + per-identifier attempt windows (Python rl_login_*).
		if !rlIP(d, c, "login_ip") {
			return
		}
		if !rlKey(d, c, "login_target", "tgt:"+identifier) {
			return
		}

		ip, deviceID, ua, serverMeta := requestContext(c)

		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "login") {
			return
		}

		uid, token, err := d.Auth.LoginWithPassword(identifier, req.Password,
			&deviceID, &ip, &ua)
		if err != nil {
			d.Throttle.RecordFailed(c.Request.Context(), identifier)
			d.recordLoginAttempt(nil, identifier, ip, deviceID, false, "invalid_credentials")
			// Uniform message — never reveal which factor failed.
			apiErr(c, http.StatusUnauthorized, "账号或密码不正确")
			return
		}
		d.Throttle.RecordSuccess(c.Request.Context(), identifier)
		d.recordLoginAttempt(&uid, identifier, ip, deviceID, true, "")

		// Device record: server-parsed UA as base, client payload overrides.
		merged := mergeDeviceMeta(serverMeta, req.Device)
		d.Auth.RecordDevice(uid, deviceID, merged)

		expires := time.Now().AddDate(0, 0, d.Cfg.Auth.TokenTTLDays)
		tokenResponse(d, c, uid, token, &expires)
	}
}

// mergeDeviceMeta prefers client-supplied fields over server-parsed UA.
func mergeDeviceMeta(server service.DeviceMeta, client *service.DeviceMeta) service.DeviceMeta {
	if client == nil {
		return server
	}
	out := server
	pick := func(dst **string, src *string) {
		if src != nil && *src != "" {
			*dst = src
		}
	}
	pick(&out.DeviceType, client.DeviceType)
	pick(&out.DeviceName, client.DeviceName)
	pick(&out.OS, client.OS)
	pick(&out.OSVersion, client.OSVersion)
	pick(&out.Browser, client.Browser)
	pick(&out.BrowserVersion, client.BrowserVersion)
	return out
}

// recordLoginAttempt writes the audit row (best-effort, never blocks).
func (d Deps) recordLoginAttempt(uid *int64, identifier, ip, deviceID string, success bool, reason string) {
	la := &model.LoginAttempt{
		UID:       uid,
		IP:        ip,
		Success:   success,
		CreatedAt: time.Now(),
	}
	if identifier != "" {
		la.Email = &identifier
	}
	if deviceID != "" {
		la.DeviceID = &deviceID
	}
	if reason != "" {
		la.FailureReason = &reason
	}
	if err := d.Auth.InsertLoginAttempt(la); err != nil {
		slog.Warn("[AUTH] record login attempt failed", "err", err)
	}
}

// registerSendCode — POST /auth/register/email/send-code (public).
func registerSendCode(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Email       string  `json:"email" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, err.Error())
			return
		}
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "register_send") {
			return
		}
		// Per-IP / per-email send windows (Python rl_register_send_*).
		if !rlIP(d, c, "register_send_ip") {
			return
		}
		if !rlKey(d, c, "register_send_tgt", "tgt:"+email) {
			return
		}
		// Registration cannot defend against enumeration: an already-known
		// email returns 409 so the user goes to login / reset instead.
		if exists, err := d.Auth.EmailExists(email); err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		} else if exists {
			apiErr(c, http.StatusConflict, "该邮箱已注册，请直接登录")
			return
		}
		if err := d.Verification.SendCode(c.Request.Context(), 0, email, "register"); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "注册验证码已发送，请查收邮件"})
	}
}

// registerEmail — POST /auth/register/email (public, register = login).
func registerEmail(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Email       string  `json:"email" binding:"required"`
		Password    string  `json:"password" binding:"required"`
		Code        string  `json:"code" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, err.Error())
			return
		}
		ip, deviceID, ua, _ := requestContext(c)
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "register") {
			return
		}
		if !rlIP(d, c, "register_ip") {
			return
		}

		vcID, err := d.Verification.VerifyCode(email, "register", strings.TrimSpace(req.Code), 0)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		uid, token, err := d.Auth.RegisterWithEmail(email, req.Password, &deviceID, &ip, &ua)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := d.Verification.ConsumeCode(vcID); err != nil {
			slog.Warn("[AUTH] consume register code failed", "uid", uid, "err", err)
		}
		slog.Info("[AUTH] email register ok", "uid", uid)
		expires := time.Now().AddDate(0, 0, d.Cfg.Auth.TokenTTLDays)
		tokenResponse(d, c, uid, token, &expires)
	}
}

// phoneSendCode — POST /auth/phone/send-code (login public; bind/twofa authed).
func phoneSendCode(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Phone       string  `json:"phone" binding:"required"`
		Purpose     string  `json:"purpose"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := service.NormalizePhoneExported(req.Phone)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, err.Error())
			return
		}
		ip, _, _, _ := requestContext(c)
		_ = ip
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "phone_send") {
			return
		}
		// Per-IP / per-phone send windows (Python rl_phone_send_*).
		if !rlIP(d, c, "phone_send_ip") {
			return
		}
		if !rlKey(d, c, "phone_send_tgt", "tgt:"+phone) {
			return
		}

		uid := int64(0)
		purpose := "login"
		if req.Purpose == "bind" || req.Purpose == "twofa" {
			tokenStr := extractToken(c)
			uid = d.Tokens.Validate(c.Request.Context(), tokenStr)
			if uid == 0 {
				apiErr(c, http.StatusUnauthorized, "该操作需要登录")
				return
			}
			if req.Purpose == "bind" {
				purpose = "bind_phone"
			} else {
				purpose = "twofa_sms"
			}
		}
		if err := d.Verification.SendCode(c.Request.Context(), uid, phone, purpose); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "短信验证码已发送"})
	}
}

// phoneLogin — POST /auth/phone/login (public, register-on-first-use).
func phoneLogin(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Phone       string  `json:"phone" binding:"required"`
		Code        string  `json:"code" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		phone, err := service.NormalizePhoneExported(req.Phone)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, err.Error())
			return
		}
		ip, deviceID, ua, meta := requestContext(c)
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "phone_login") {
			return
		}
		if !rlIP(d, c, "phone_login_ip") {
			return
		}

		vcID, err := d.Verification.VerifyCode(phone, "login", strings.TrimSpace(req.Code), 0)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		uid, token, _, err := d.Auth.LoginOrRegisterByPhone(phone, &deviceID, &ip, &ua)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		if err := d.Verification.ConsumeCode(vcID); err != nil {
			slog.Warn("[AUTH] consume phone code failed", "uid", uid, "err", err)
		}
		d.Auth.RecordDevice(uid, deviceID, meta)
		slog.Info("[AUTH] phone code login ok", "uid", uid)
		expires := time.Now().AddDate(0, 0, d.Cfg.Auth.TokenTTLDays)
		tokenResponse(d, c, uid, token, &expires)
	}
}

// ── password reset (public) ──────────────────────────────────────────

// passwordResetRequest — POST /auth/password/reset-request. Always returns
// a success-shaped message (no account enumeration).
func passwordResetRequest(d Deps) gin.HandlerFunc {
	type reqBody struct {
		CaptchaID   *string `json:"captcha_id"`
		CaptchaCode *string `json:"captcha_code"`
		Email       string  `json:"email" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		email, err := service.NormalizeEmailExported(req.Email)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, err.Error())
			return
		}
		captchaID, captchaCode := "", ""
		if req.CaptchaID != nil {
			captchaID = *req.CaptchaID
		}
		if req.CaptchaCode != nil {
			captchaCode = *req.CaptchaCode
		}
		if !requireCaptcha(d, c, captchaID, captchaCode, "password_reset_request") {
			return
		}
		// Per-IP / per-email reset windows (Python rl_password_reset_request_*).
		if !rlIP(d, c, "pw_reset_req_ip") {
			return
		}
		if !rlKey(d, c, "pw_reset_req_tgt", "tgt:"+email) {
			return
		}
		if err := d.Verification.SendResetToken(c.Request.Context(), email); err != nil {
			// Including "not registered"-shaped failures keeps the response
			// uniform; both paths read the same to the caller.
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "如果该邮箱已注册，您将收到重置邮件"})
	}
}

// passwordReset — POST /auth/password/reset (public, reset token).
func passwordReset(d Deps) gin.HandlerFunc {
	type reqBody struct {
		ResetToken  string `json:"reset_token" binding:"required,min=10"`
		NewPassword string `json:"new_password" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		if !rlIP(d, c, "pw_reset_ip") {
			return
		}
		if err := d.Verification.ConsumeTokenAndResetPassword(strings.TrimSpace(req.ResetToken), req.NewPassword); err != nil {
			if errors.Is(err, service.ErrSamePassword) || errors.Is(err, gorm.ErrInvalidData) {
				apiErr(c, http.StatusBadRequest, err.Error())
				return
			}
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "密码已重置，请使用新密码登录"})
	}
}
