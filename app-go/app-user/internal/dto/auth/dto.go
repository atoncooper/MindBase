// Package auth defines the HTTP wire contract for the auth domain: validated
// request DTOs and response DTOs. Routers bind these types and map service
// responses into them; the DTO layer must not import service, repo or router
// packages.
package auth

import (
	"app-user/internal/utils"
)

// ── Authentication ───────────────────────────────────────────────────

// LoginRequest is POST /auth/login (email xor phone + password).
type LoginRequest struct {
	CaptchaID   *string           `json:"captcha_id"`
	CaptchaCode *string           `json:"captcha_code"`
	Email       *string           `json:"email"`
	Phone       *string           `json:"phone"`
	Password    string            `json:"password" binding:"required"`
	Device      *utils.DeviceMeta `json:"device"`
}

// AttestRequest is POST /auth/attest.
type AttestRequest struct {
	Challenge   string `json:"challenge"`
	Fingerprint string `json:"fingerprint"`
}

// RegisterSendCodeRequest is POST /auth/register/email/send-code.
type RegisterSendCodeRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Email       string  `json:"email" binding:"required"`
}

// RegisterEmailRequest is POST /auth/register/email (register = login).
type RegisterEmailRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Email       string  `json:"email" binding:"required"`
	Password    string  `json:"password" binding:"required"`
	Code        string  `json:"code" binding:"required"`
}

// PhoneSendCodeRequest is POST /auth/phone/send-code. Phone is optional
// because purpose=unbind targets the currently bound number.
type PhoneSendCodeRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Phone       string  `json:"phone"`
	Purpose     string  `json:"purpose"`
}

// PhoneLoginRequest is POST /auth/phone/login (register on first use).
type PhoneLoginRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Phone       string  `json:"phone" binding:"required"`
	Code        string  `json:"code" binding:"required"`
}

// PasswordResetRequest is POST /auth/password/reset-request.
type PasswordResetRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Email       string  `json:"email" binding:"required"`
}

// PasswordResetConfirmRequest is POST /auth/password/reset.
type PasswordResetConfirmRequest struct {
	ResetToken  string `json:"reset_token" binding:"required,min=10"`
	NewPassword string `json:"new_password" binding:"required"`
}

// WeChatRequest is POST /auth/wechat/login and POST /auth/wechat/bind.
type WeChatRequest struct {
	Code  string `json:"code" binding:"required"`
	State string `json:"state" binding:"required"`
}

// ── Account ──────────────────────────────────────────────────────────

// SetPasswordRequest is POST /auth/password/set (mandatory second factor).
type SetPasswordRequest struct {
	Password  string  `json:"password" binding:"required"`
	EmailCode *string `json:"email_code"`
	SMSCode   *string `json:"sms_code"`
}

// ChangePasswordRequest is PATCH /auth/password.
type ChangePasswordRequest struct {
	OldPassword string  `json:"old_password" binding:"required"`
	NewPassword string  `json:"new_password" binding:"required"`
	EmailCode   *string `json:"email_code"`
	SMSCode     *string `json:"sms_code"`
}

// BindEmailRequest is PUT /auth/email (direct bind, unverified).
type BindEmailRequest struct {
	Email           string `json:"email" binding:"required"`
	CurrentPassword string `json:"current_password"`
}

// EmailSendCodeRequest is POST /auth/email/send-code.
type EmailSendCodeRequest struct {
	CaptchaID   *string `json:"captcha_id"`
	CaptchaCode *string `json:"captcha_code"`
	Email       string  `json:"email" binding:"required"`
	Purpose     string  `json:"purpose"`
}

// EmailVerifyRequest is POST /auth/email/verify.
type EmailVerifyRequest struct {
	Email           string `json:"email" binding:"required"`
	Code            string `json:"code" binding:"required"`
	Purpose         string `json:"purpose"`
	CurrentPassword string `json:"current_password"`
}

// BindPhoneRequest is PUT /auth/phone (direct bind, unverified).
type BindPhoneRequest struct {
	Phone           string `json:"phone" binding:"required"`
	CurrentPassword string `json:"current_password"`
}

// UnbindPhoneRequest is DELETE /auth/phone (body optional).
type UnbindPhoneRequest struct {
	Code            string `json:"code"`
	CurrentPassword string `json:"current_password"`
}

// PhoneVerifyRequest is POST /auth/phone/verify.
type PhoneVerifyRequest struct {
	Phone           string `json:"phone" binding:"required"`
	Code            string `json:"code" binding:"required"`
	CurrentPassword string `json:"current_password"`
}

// Coding Plan DTOs moved to internal/dto/settings (settings domain):
// POST/GET /settings/coding-plans.
