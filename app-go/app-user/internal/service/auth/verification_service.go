package service

import (
	"app-user/internal/utils"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"time"

	"app-user/internal/config"
	"app-user/internal/model/auth"
	"app-user/internal/repo/auth"

	"gorm.io/gorm"
)

// Verification — orchestrates the verification-code lifecycle:
// generate → persist (per-target cooldown + per-uid window) → deliver
// (Resend email / Aliyun SMS) → verify (single-use, brute-force cap) →
// multi-step flows (password change with 2FA, email bind, password reset).
// Port of the Python VerificationService.
type Verification struct {
	cfg   *config.AuthConfig
	email *EmailService
	sms   *SMSService
	auth  *AuthService
	repo  *repo.VerificationRepo
	users *repo.UserRepo
}

func NewVerification(cfg *config.AuthConfig, email *EmailService, sms *SMSService, auth *AuthService) *Verification {
	return &Verification{
		cfg:   cfg,
		email: email,
		sms:   sms,
		auth:  auth,
		repo:  repo.NewVerificationRepo(),
		users: repo.NewUserRepo(),
	}
}

var phoneRe = regexp.MustCompile(`^1[3-9]\d{9}$`)

var (
	emailPurposes = map[string]bool{"bind_email": true, "reset_password": true, "twofa": true, "register": true}
	smsPurposes   = map[string]bool{"login": true, "bind_phone": true, "twofa_sms": true}
)

var errInvalidPurpose = errors.New("无效的验证用途")

func (v *Verification) channel(purpose string) (string, bool) {
	if emailPurposes[purpose] {
		return "email", true
	}
	if smsPurposes[purpose] {
		return "sms", true
	}
	return "", false
}

// SendCode generates, persists and delivers a code for (uid, target, purpose).
// uid may be 0 for pre-registration flows.
func (v *Verification) SendCode(ctx context.Context, uid int64, target, purpose string) error {
	channel, ok := v.channel(purpose)
	if !ok {
		return errInvalidPurpose
	}
	if target == "" {
		return errors.New("接收方不能为空")
	}
	if channel == "sms" && !phoneRe.MatchString(target) {
		return errors.New("手机号格式不正确")
	}
	db := v.auth.DB()
	if err := v.enforceRateLimits(db, uid, target); err != nil {
		return err
	}
	code, err := numericCode(v.cfg.Email.CodeLength)
	if err != nil {
		return err
	}
	now := time.Now()
	var uidPtr *int64
	if uid != 0 {
		uidPtr = &uid
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		if err := v.repo.InvalidateOlder(tx, target, purpose); err != nil {
			return err
		}
		return v.repo.Create(tx, &model.VerificationCode{
			UID:     uidPtr,
			Target:  target,
			Type:    channel,
			Purpose: purpose,
			Code:    code,
			// used column is nullable with no DB default; NULL never matches
			// the "used = 0" lookups, so it must be written explicitly.
			ExpiresAt: now.Add(time.Duration(v.cfg.Email.CodeTTLSeconds) * time.Second),
			Used:      utils.BoolPtr(false),
			Attempts:  utils.IntPtr(0),
			CreatedAt: &now,
		})
	}); err != nil {
		return err
	}

	// Delivery outside the tx — a sent message with a persisted code is
	// recoverable; the rate limit gates retries (parity with Python).
	if channel == "sms" {
		if err := v.sms.SendSms(ctx, target, code); err != nil {
			slog.Warn("[VERIFY] sms send failed", "uid", uid, "purpose", purpose, "err", err)
			return err
		}
	} else {
		if err := v.email.SendVerificationCode(ctx, target, code, purpose); err != nil {
			slog.Warn("[VERIFY] email send failed", "uid", uid, "purpose", purpose, "err", err)
			return err
		}
	}
	slog.Info("[VERIFY] code sent", "channel", channel, "uid", uid, "purpose", purpose)
	return nil
}

// SendResetToken emails a 32-byte reset token (10-minute TTL) to a
// registered address, without leaking whether the email exists.
func (v *Verification) SendResetToken(ctx context.Context, target string) error {
	db := v.auth.DB()
	user, err := v.users.GetByEmail(db, target)
	if err != nil {
		return err
	}
	if user == nil {
		// Do not leak account existence; the router returns a success-shaped
		// message regardless.
		return errors.New("如果该邮箱已注册，您将收到重置邮件")
	}
	// Password reset is a credential-recovery path: only a verified mailbox may
	// receive the link. An unverified (just-attached) address must not be able
	// to take over the account.
	if user.EmailVerified == nil || !*user.EmailVerified {
		return errors.New("如果该邮箱已注册，您将收到重置邮件")
	}
	if err := v.enforceRateLimits(db, user.UID, target); err != nil {
		return err
	}
	token, err := utils.RandomToken(32)
	if err != nil {
		return err
	}
	now := time.Now()
	if err := db.Transaction(func(tx *gorm.DB) error {
		if err := v.repo.InvalidateOlder(tx, target, "reset_password"); err != nil {
			return err
		}
		return v.repo.Create(tx, &model.VerificationCode{
			UID:       &user.UID,
			Target:    target,
			Type:      "email",
			Purpose:   "reset_password",
			Code:      hashResetToken(token),
			ExpiresAt: now.Add(600 * time.Second),
			Used:      utils.BoolPtr(false),
			Attempts:  utils.IntPtr(0),
			CreatedAt: &now,
		})
	}); err != nil {
		return err
	}
	if err := v.email.SendVerificationCode(ctx, target, token, "reset_password"); err != nil {
		return err
	}
	slog.Info("[VERIFY] reset token sent", "uid", user.UID)
	return nil
}

// VerifyCode checks a user-supplied code WITHOUT consuming it; returns the
// verification_codes row id. Caller must ConsumeCode after the business
// step succeeds so a failed business step leaves the code retryable.
func (v *Verification) VerifyCode(target, purpose, code string, uid int64) (int64, error) {
	db := v.auth.DB()
	vc, err := v.repo.FindLatestUnused(db, target, purpose)
	if err != nil {
		return 0, err
	}
	if vc == nil {
		return 0, errors.New("验证码已过期或未发送，请重新获取")
	}
	if uid != 0 && vc.UID != nil && *vc.UID != uid {
		return 0, errors.New("验证码无效")
	}
	attempts := 0
	if vc.Attempts != nil {
		attempts = *vc.Attempts
	}
	if attempts >= v.cfg.Email.MaxVerifyAttempts {
		_ = v.repo.MarkUsed(db, vc.ID)
		slog.Warn("[VERIFY] brute-force cap reached", "target", target, "purpose", purpose)
		return 0, errors.New("验证码错误次数过多，请重新获取")
	}
	if subtle.ConstantTimeCompare([]byte(vc.Code), []byte(code)) != 1 {
		newAttempts, _ := v.repo.BumpAttempts(db, target, purpose, vc.Code)
		slog.Info("[VERIFY] wrong code", "purpose", purpose, "attempts", newAttempts)
		return 0, errors.New("验证码不正确")
	}
	return vc.ID, nil
}

// ConsumeCode marks a verified code used (after the business step succeeds).
func (v *Verification) ConsumeCode(id int64) error {
	return v.repo.MarkUsed(v.auth.DB(), id)
}

// VerifyAndChangePassword — change password with a mandatory second factor
// when a verified contact exists: email code when an email is verified, SMS
// code when only a phone is verified (either one is accepted when both are
// verified). Verify → change → consume.
func (v *Verification) VerifyAndChangePassword(uid int64, oldPassword, newPassword, emailCode, smsCode string) error {
	db := v.auth.DB()
	user, err := v.users.GetByUID(db, uid)
	if err != nil {
		return err
	}
	emailReady := user != nil && user.EmailVerified != nil && *user.EmailVerified && user.Email != nil
	phoneReady := user != nil && user.PhoneVerified != nil && *user.PhoneVerified && user.Phone != nil

	var vcID int64
	switch {
	case emailReady && emailCode != "":
		vcID, err = v.VerifyCode(*user.Email, "twofa", emailCode, uid)
	case phoneReady && smsCode != "":
		vcID, err = v.VerifyCode(*user.Phone, "twofa_sms", smsCode, uid)
	case emailReady:
		return errors.New("修改密码需要邮箱验证码")
	case phoneReady:
		return errors.New("修改密码需要短信验证码")
	}
	if err != nil {
		return err
	}
	if err := v.auth.ChangePassword(uid, oldPassword, newPassword); err != nil {
		return err
	}
	if vcID != 0 {
		if err := v.ConsumeCode(vcID); err != nil {
			return err
		}
	}
	if emailReady {
		v.notifyPasswordChanged(*user.Email)
	}
	return nil
}

// NotifyContactChange sends a best-effort alert to the account's verified
// mailbox after an email/phone bind, verify or unbind.
func (v *Verification) NotifyContactChange(toEmail, change string) {
	if toEmail == "" || change == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := v.email.SendContactChangedNotice(ctx, toEmail, change); err != nil {
			slog.Warn("[VERIFY] contact change notice failed", "err", err)
		}
	}()
}

// notifyPasswordChanged sends a best-effort security alert. It runs in the
// background so the password-change response is not blocked on Resend.
func (v *Verification) notifyPasswordChanged(email string) {
	if email == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := v.email.SendPasswordChangedNotice(ctx, email); err != nil {
			slog.Warn("[VERIFY] password changed notice failed", "err", err)
		}
	}()
}

// VerifyAndSetPassword — first-time password set with a mandatory second
// factor: email code when a verified email exists, SMS code when only a
// verified phone exists, otherwise refused (parity with the Python flow —
// a bare session must not be able to plant a persistent credential).
func (v *Verification) VerifyAndSetPassword(uid int64, newPassword, emailCode, smsCode string) error {
	db := v.auth.DB()
	user, err := v.users.GetByUID(db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	var vcID int64
	switch {
	case user.EmailVerified != nil && *user.EmailVerified && user.Email != nil:
		if emailCode == "" {
			return errors.New("设置密码需要邮箱验证码")
		}
		vcID, err = v.VerifyCode(*user.Email, "twofa", emailCode, uid)
		if err != nil {
			return err
		}
	case user.PhoneVerified != nil && *user.PhoneVerified && user.Phone != nil:
		if smsCode == "" {
			return errors.New("设置密码需要短信验证码")
		}
		vcID, err = v.VerifyCode(*user.Phone, "twofa_sms", smsCode, uid)
		if err != nil {
			return err
		}
	default:
		return errors.New("请先绑定并验证邮箱或手机号，再设置密码")
	}
	if err := v.auth.SetPassword(uid, newPassword); err != nil {
		return err
	}
	return v.ConsumeCode(vcID)
}

// VerifyAndBindEmail — verify code and bind (bind_email) or just verify
// (twofa). Order: verify → bind → consume (consume only after bind succeeds).
func (v *Verification) VerifyAndBindEmail(uid int64, email, code, purpose string) error {
	vcID, err := v.VerifyCode(email, purpose, code, uid)
	if err != nil {
		return err
	}
	if purpose == "bind_email" {
		if err := v.auth.ApplyVerifiedEmail(uid, email); err != nil {
			return err
		}
	}
	return v.ConsumeCode(vcID)
}

// VerifyAndBindPhone — verify SMS code and bind the phone (login state).
func (v *Verification) VerifyAndBindPhone(uid int64, phone, code string) error {
	vcID, err := v.VerifyCode(phone, "bind_phone", code, uid)
	if err != nil {
		return err
	}
	if err := v.auth.ApplyVerifiedPhone(uid, phone); err != nil {
		return err
	}
	return v.ConsumeCode(vcID)
}

// ConsumeTokenAndResetPassword — verify + burn the reset token, then reset
// the password. Atomically ordered: burn first (single use), then reset.
func (v *Verification) ConsumeTokenAndResetPassword(token, newPassword string) (int64, error) {
	db := v.auth.DB()
	tokenHash := hashResetToken(token)
	vc, err := v.repo.FindLatestUnusedResetToken(db, tokenHash)
	if err != nil {
		return 0, err
	}
	if vc == nil || vc.UID == nil {
		return 0, errors.New("重置链接无效或已过期")
	}
	uid := *vc.UID
	if err := v.repo.MarkUsedResetToken(db, tokenHash); err != nil {
		return 0, err
	}
	if err := v.auth.ResetPassword(uid, newPassword); err != nil {
		return 0, err
	}
	if user, uerr := v.users.GetByUID(db, uid); uerr == nil && user != nil &&
		user.EmailVerified != nil && *user.EmailVerified && user.Email != nil {
		v.notifyPasswordChanged(*user.Email)
	}
	return uid, nil
}

// hashResetToken stores reset tokens as SHA-256 digests: a database leak must
// not hand out working password-reset links.
func hashResetToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// enforceRateLimits raises when the per-target cooldown or per-uid window
// would be exceeded (data comes from verification_codes, MySQL-backed).
func (v *Verification) enforceRateLimits(db *gorm.DB, uid int64, target string) error {
	now := time.Now()
	n, err := v.repo.CountRecentByTarget(db, target,
		now.Add(-time.Duration(v.cfg.Email.RateLimitTargetSeconds)*time.Second))
	if err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("请求过于频繁，请 %d 秒后重试", v.cfg.Email.RateLimitTargetSeconds)
	}
	if uid == 0 {
		return nil
	}
	m, err := v.repo.CountRecentByUID(db, uid,
		now.Add(-time.Duration(v.cfg.Email.RateLimitUIDMinutes)*time.Minute))
	if err != nil {
		return err
	}
	if m >= int64(v.cfg.Email.RateLimitUIDMax) {
		return errors.New("请求过于频繁，请稍后重试")
	}
	return nil
}

// numericCode generates a cryptographically random numeric code.
func numericCode(length int) (string, error) {
	out := make([]byte, length)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + n.Int64())
	}
	return string(out), nil
}
