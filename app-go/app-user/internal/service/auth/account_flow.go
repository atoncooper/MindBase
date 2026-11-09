package service

import (
	"context"
	"errors"
	"strings"

	authdto "app-user/internal/dto/auth"
	"app-user/internal/utils"
)

// FlowStatus classifies an account-flow failure at the domain boundary. The
// HTTP layer maps it to a status code; services never import net/http.
type FlowStatus int

const (
	// FlowInvalid is a business rejection (HTTP 400).
	FlowInvalid FlowStatus = iota
	// FlowUnprocessable is a malformed-but-well-typed input (HTTP 422).
	FlowUnprocessable
	// FlowUnauthorized means the caller must (re)authenticate (HTTP 401).
	FlowUnauthorized
	// FlowForbidden means the caller lacks the required proof (HTTP 403).
	FlowForbidden
	// FlowNotFound is a missing resource (HTTP 404).
	FlowNotFound
	// FlowConflict is a uniqueness conflict (HTTP 409).
	FlowConflict
)

// FlowError wraps a business error with its boundary classification so the
// router can pick a status code without matching on error text.
type FlowError struct {
	Status FlowStatus
	Err    error
}

func (e *FlowError) Error() string { return e.Err.Error() }

// Unwrap keeps errors.Is/As working through the classification wrapper.
func (e *FlowError) Unwrap() error { return e.Err }

func flowError(status FlowStatus, err error) error {
	return &FlowError{Status: status, Err: err}
}

// Phone-flow / contact-flow errors. Wrapped in a FlowError before returning.
var (
	ErrPhoneSendLoginRequired   = errors.New("该操作需要登录")
	ErrPhoneSendUnavailable     = errors.New("账号不可用")
	ErrPhoneSendNoVerifiedPhone = errors.New("当前账号没有已验证的手机号")
	ErrSMSBindingRequiresCode   = errors.New("短信服务已启用，请使用短信验证码验证绑定")
	ErrEmailPurposeInvalid      = errors.New("purpose 必须为 bind_email 或 twofa")
	ErrPhoneNotBound            = errors.New("当前账号未绑定手机号")
	ErrPhoneUnbindNeedsPassword = errors.New("当前手机号未验证，请使用当前密码解绑")
)

// SendCodePlan is the resolved orchestration of a send-code request: which
// account (uid, 0 = pre-registration) and target receive which internal
// verification purpose.
type SendCodePlan struct {
	UID     int64
	Target  string
	Purpose string
}

// normalizePhoneSendPurpose maps the public purpose to the internal
// verification purpose and reports whether the caller must be authenticated.
// Unknown/empty values fall back to the public login path (parity with the
// original handler).
func normalizePhoneSendPurpose(purpose string) (public, internal string, requiresAuth bool) {
	switch strings.TrimSpace(purpose) {
	case "bind":
		return "bind", "bind_phone", true
	case "twofa":
		return "twofa", "twofa_sms", true
	case "unbind":
		return "unbind", "unbind_phone", true
	default:
		return "login", "login", false
	}
}

// normalizeEmailPurpose validates the email send/verify purpose (default
// bind_email; twofa is the check-only flow).
func normalizeEmailPurpose(purpose string) (string, error) {
	switch p := strings.TrimSpace(purpose); p {
	case "":
		return "bind_email", nil
	case "bind_email", "twofa":
		return p, nil
	default:
		return "", flowError(FlowUnprocessable, ErrEmailPurposeInvalid)
	}
}

// ResolvePhoneSendCaller resolves the caller for POST /auth/phone/send-code:
// authed purposes (bind/twofa/unbind) require a valid session and an active
// account; public login purposes resolve to uid 0.
func (s *AuthService) ResolvePhoneSendCaller(ctx context.Context, token, purpose string) (int64, error) {
	if _, _, requiresAuth := normalizePhoneSendPurpose(purpose); !requiresAuth {
		return 0, nil
	}
	if s.tokens == nil || token == "" {
		return 0, flowError(FlowUnauthorized, ErrPhoneSendLoginRequired)
	}
	uid := s.tokens.Validate(ctx, token)
	if uid == 0 {
		return 0, flowError(FlowUnauthorized, ErrPhoneSendLoginRequired)
	}
	if err := s.CheckActive(ctx, uid); err != nil {
		return 0, flowError(FlowUnauthorized, ErrPhoneSendUnavailable)
	}
	return uid, nil
}

// PlanPhoneSendCode resolves the receiving phone and the internal verification
// purpose for POST /auth/phone/send-code. For purpose=unbind the target is
// always the currently bound and verified phone (a caller-supplied number is
// ignored), so a stolen session cannot redirect the code.
func (v *Verification) PlanPhoneSendCode(uid int64, requestedPhone, purpose string) (*SendCodePlan, error) {
	public, internal, requiresAuth := normalizePhoneSendPurpose(purpose)
	if requiresAuth && uid <= 0 {
		return nil, flowError(FlowUnauthorized, ErrPhoneSendLoginRequired)
	}
	if public == "unbind" {
		profile, err := v.auth.GetFullProfile(uid)
		if err != nil || profile == nil || profile.Phone == nil || !profile.PhoneVerified {
			return nil, flowError(FlowInvalid, ErrPhoneSendNoVerifiedPhone)
		}
		return &SendCodePlan{UID: uid, Target: *profile.Phone, Purpose: internal}, nil
	}
	phone, err := utils.NormalizePhone(requestedPhone)
	if err != nil {
		return nil, flowError(FlowUnprocessable, err)
	}
	return &SendCodePlan{UID: uid, Target: phone, Purpose: internal}, nil
}

// PlanEmailSendCode resolves the target/email purpose for POST
// /auth/email/send-code without delivering anything (captcha and rate limits
// still run in the router before SendCode).
func (v *Verification) PlanEmailSendCode(uid int64, email, purpose string) (*SendCodePlan, error) {
	target, err := utils.NormalizeEmail(email)
	if err != nil {
		return nil, flowError(FlowInvalid, err)
	}
	p, err := normalizeEmailPurpose(purpose)
	if err != nil {
		return nil, err
	}
	return &SendCodePlan{UID: uid, Target: target, Purpose: p}, nil
}

// BindEmailDirect implements PUT /auth/email: password step-up, then attach
// the address (unverified), then alert the previously verified mailbox when it
// actually changed.
func (v *Verification) BindEmailDirect(uid int64, email, currentPassword string) (string, error) {
	normalized, err := utils.NormalizeEmail(email)
	if err != nil {
		return "", flowError(FlowInvalid, err)
	}
	before, _ := v.auth.GetFullProfile(uid)
	if err := v.auth.RequireStepUp(uid, currentPassword); err != nil {
		return "", flowError(FlowForbidden, err)
	}
	if err := v.auth.BindEmail(uid, normalized); err != nil {
		return "", flowError(FlowInvalid, err)
	}
	if before == nil || before.Email == nil || *before.Email != normalized {
		v.notifyContactChange(before, "邮箱已更换为 "+normalized)
	}
	return normalized, nil
}

// BindEmailVerified implements POST /auth/email/verify: purpose validation,
// password step-up for bind_email, code verification/binding and the change
// notice to the previously verified mailbox. Returns the normalized email and
// purpose for the response envelope.
func (v *Verification) BindEmailVerified(uid int64, email, code, purpose, currentPassword string) (string, string, error) {
	normalized, err := utils.NormalizeEmail(email)
	if err != nil {
		return "", "", flowError(FlowInvalid, err)
	}
	p, err := normalizeEmailPurpose(purpose)
	if err != nil {
		return "", "", err
	}
	var before *authdto.Profile
	if p == "bind_email" {
		// Attaching a new recovery address is security-sensitive: require the
		// current password (or force a password to be set first).
		before, _ = v.auth.GetFullProfile(uid)
		if err := v.auth.RequireStepUp(uid, currentPassword); err != nil {
			return "", "", flowError(FlowForbidden, err)
		}
	}
	if err := v.VerifyAndBindEmail(uid, normalized, strings.TrimSpace(code), p); err != nil {
		return "", "", flowError(FlowInvalid, err)
	}
	if p == "bind_email" && (before == nil || before.Email == nil || *before.Email != normalized) {
		v.notifyContactChange(before, "邮箱已更换为 "+normalized)
	}
	return normalized, p, nil
}

// UnbindEmailAccount implements DELETE /auth/email: unbind then alert the
// previously verified mailbox (best-effort).
func (v *Verification) UnbindEmailAccount(uid int64) error {
	before, _ := v.auth.GetFullProfile(uid)
	if err := v.auth.UnbindEmail(uid); err != nil {
		return flowError(FlowInvalid, err)
	}
	v.notifyContactChange(before, "邮箱已解绑")
	return nil
}

// BindPhoneDirect implements PUT /auth/phone: direct (unverified) binding is
// only allowed while SMS delivery is not configured; otherwise the caller must
// use the code-verified endpoint.
func (v *Verification) BindPhoneDirect(uid int64, phone, currentPassword string) (string, error) {
	if v.cfg.SMS.Configured() {
		return "", flowError(FlowForbidden, ErrSMSBindingRequiresCode)
	}
	normalized, err := utils.NormalizePhone(phone)
	if err != nil {
		return "", flowError(FlowInvalid, err)
	}
	before, _ := v.auth.GetFullProfile(uid)
	if err := v.auth.RequireStepUp(uid, currentPassword); err != nil {
		return "", flowError(FlowForbidden, err)
	}
	if err := v.auth.BindPhone(uid, normalized); err != nil {
		return "", flowError(FlowInvalid, err)
	}
	v.notifyContactChange(before, "手机号已绑定为 "+normalized)
	return normalized, nil
}

// BindPhoneVerified implements POST /auth/phone/verify: step-up, SMS code
// verification + bind, then the change notice.
func (v *Verification) BindPhoneVerified(uid int64, phone, code, currentPassword string) (string, error) {
	normalized, err := utils.NormalizePhone(phone)
	if err != nil {
		return "", flowError(FlowInvalid, err)
	}
	before, _ := v.auth.GetFullProfile(uid)
	if err := v.auth.RequireStepUp(uid, currentPassword); err != nil {
		return "", flowError(FlowForbidden, err)
	}
	if err := v.VerifyAndBindPhone(uid, normalized, strings.TrimSpace(code)); err != nil {
		return "", flowError(FlowInvalid, err)
	}
	v.notifyContactChange(before, "手机号已绑定为 "+normalized)
	return normalized, nil
}

// UnbindPhoneAccount implements DELETE /auth/phone: a valid SMS code sent to
// the currently bound, verified phone OR the account password (step-up) is
// required; then unbind and alert the mailbox.
func (v *Verification) UnbindPhoneAccount(uid int64, code, currentPassword string) error {
	before, err := v.auth.GetFullProfile(uid)
	if err != nil {
		return flowError(FlowInvalid, err)
	}
	if before == nil || before.Phone == nil {
		return flowError(FlowInvalid, ErrPhoneNotBound)
	}
	code = strings.TrimSpace(code)
	var codeID int64
	if code != "" {
		if !before.PhoneVerified {
			return flowError(FlowInvalid, ErrPhoneUnbindNeedsPassword)
		}
		codeID, err = v.VerifyCode(*before.Phone, "unbind_phone", code, uid)
		if err != nil {
			return flowError(FlowInvalid, err)
		}
	} else if err := v.auth.RequireStepUp(uid, currentPassword); err != nil {
		return flowError(FlowForbidden, err)
	}
	if err := v.auth.UnbindPhone(uid); err != nil {
		return flowError(FlowInvalid, err)
	}
	if codeID != 0 {
		_ = v.ConsumeCode(codeID)
	}
	v.notifyContactChange(before, "手机号已解绑")
	return nil
}

// notifyContactChange alerts the verified mailbox captured before a contact
// mutation. Best-effort; a missing/unverified email yields no notification.
func (v *Verification) notifyContactChange(before *authdto.Profile, change string) {
	if before == nil || !before.EmailVerified || before.Email == nil || *before.Email == "" {
		return
	}
	v.NotifyContactChange(*before.Email, change)
}
