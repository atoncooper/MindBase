package service

import (
	"app-user/internal/utils"
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"app-user/internal/config"
	"app-user/internal/infra/cache"
	"app-user/internal/infra/security"
	"app-user/internal/model/auth"
	"app-user/internal/repo/auth"

	"gorm.io/gorm"
)

// NormalizeAvatarURL upgrades legacy http:// avatar links (bilibili face
// i0.hdslb.com, WeChat headimg CDNs) to https://. Both CDNs serve over TLS;
// the http form becomes mixed content on the HTTPS site and browsers silently
// block the request — the "avatar never displays" bug. Site-relative URLs
// (/avatar/file/...) and already-https links pass through unchanged.
func NormalizeAvatarURL(u *string) *string {
	if u == nil || *u == "" {
		return u
	}
	if strings.HasPrefix(*u, "http://") {
		upgraded := "https://" + strings.TrimPrefix(*u, "http://")
		return &upgraded
	}
	return u
}

// Business-rule errors — the router layer maps them to HTTP 400/409.
var (
	ErrEmailTaken        = errors.New("该邮箱已注册")
	ErrEmailBound        = errors.New("该邮箱已被其他账号绑定")
	ErrPhoneTaken        = errors.New("该手机号已注册")
	ErrPhoneBound        = errors.New("该手机号已被其他账号绑定")
	ErrUserNotFound      = errors.New("用户不存在")
	ErrPasswordExists    = errors.New("密码已设置，请使用修改密码接口")
	ErrNoPassword        = errors.New("未设置密码，请使用密码设置接口")
	ErrOldPasswordWrong  = errors.New("旧密码不正确")
	ErrSamePassword      = errors.New("新密码不能与旧密码相同")
	ErrAccountNoPassword = errors.New("账号未注册或未设置密码")
	ErrPasswordWrong     = errors.New("密码不正确")
	ErrCantUnbind        = errors.New("至少保留一种登录方式（密码或第三方绑定），无法解绑")
	ErrOAuthBoundOther   = errors.New("该第三方账号已绑定其他用户")
	ErrAccountDisabled   = errors.New("账号已被禁用，请联系管理员")
	ErrStepUpRequired    = errors.New("该操作需要验证当前密码")
	ErrSetPasswordFirst  = errors.New("请先设置密码后再修改绑定")
	ErrPasswordReused    = errors.New("新密码不能与最近使用过的密码相同")
)

// isActiveStatus treats a NULL/empty status as active (legacy rows) and
// rejects any explicit non-active state so a manual ban actually takes effect.
func isActiveStatus(status *string) bool {
	if status == nil {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(*status)) {
	case "", "active", "normal", "ok":
		return true
	default:
		return false
	}
}

// Password strength policy — parity with user_service._validate_password_strength.
var (
	passwordLetterRe = regexp.MustCompile(`[A-Za-z]`)
	passwordDigitRe  = regexp.MustCompile(`[0-9]`)
)

func validatePasswordStrength(pw string) error {
	if pw == "" {
		return errors.New("密码不能为空")
	}
	if strings.TrimSpace(pw) != pw {
		return errors.New("密码首尾不能包含空白字符")
	}
	if len(pw) < 8 {
		return errors.New("密码至少 8 位")
	}
	if len(pw) > maxPasswordBytes {
		return errors.New("密码不能超过 72 字节（bcrypt 限制）")
	}
	if !passwordLetterRe.MatchString(pw) || !passwordDigitRe.MatchString(pw) {
		return errors.New("密码必须同时包含字母和数字")
	}
	return nil
}

// ProviderData carries the OAuth credential payload for a binding.
type ProviderData struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    *time.Time
	UnionID      string
	RawData      string
}

// ProfilePatch carries the display fields we pick from provider payloads.
type ProfilePatch struct {
	Nickname *string
	Avatar   *string
	Bio      *string
}

// AuthService — user lifecycle: OAuth ensure/bind, self registration,
// password login, profile, passwords, contact binding. Port of the Python
// UserService.
type AuthService struct {
	db        *gorm.DB
	cfg       *config.AuthConfig
	cipher    *security.Cipher
	sf        *security.Snowflake
	tokens    *TokenService
	users     *repo.UserRepo
	oauth     *repo.OAuthRepo
	devices   *repo.DeviceRepo
	rbac      *repo.RBACRepo
	passwords *repo.PasswordHistoryRepo
	events    *repo.SecurityEventRepo
	authz     *cache.AuthzCache

	// invalidateCreds drops the auth-owned in-process Bili credential cache
	// after a bind / SESSDATA refresh (nil in tests/offline).
	invalidateCreds func(uid int64)

	// bilibili binding status is resolved with a live api.bilibili.com call,
	// which can take seconds on some networks. The account page must not block
	// on it: cache per uid for a short TTL and hard-cap the upstream call.
	biliMu    sync.Mutex
	biliCache map[int64]biliCacheEntry
}

type biliCacheEntry struct {
	status BilibiliStatus
	at     time.Time
}

const (
	// short enough that a fresh bind shows up quickly, long enough that repeat
	// account-page opens do not hammer the B站 API
	biliStatusTTL = 60 * time.Second
	// the live check is best-effort: beyond this the page gets a fallback status
	biliStatusTimeout = 2500 * time.Millisecond
)

func NewAuthService(db *gorm.DB, cfg *config.AuthConfig, cipher *security.Cipher,
	sf *security.Snowflake, tokens *TokenService, rbac *RBACService,
	authz *cache.AuthzCache, invalidateCreds func(uid int64)) *AuthService {
	return &AuthService{
		db:              db,
		cfg:             cfg,
		cipher:          cipher,
		sf:              sf,
		tokens:          tokens,
		users:           repo.NewUserRepo(),
		oauth:           repo.NewOAuthRepo(),
		devices:         repo.NewDeviceRepo(),
		rbac:            rbac.repoRef(),
		passwords:       repo.NewPasswordHistoryRepo(),
		events:          repo.NewSecurityEventRepo(),
		authz:           authz,
		invalidateCreds: invalidateCreds,
		biliCache:       make(map[int64]biliCacheEntry),
	}
}

// DB exposes the shared gorm handle to sibling services (verification flow
// reuses the same pool/transaction semantics).
func (s *AuthService) DB() *gorm.DB { return s.db }

// EmailExists reports whether an active (non-deleted) user owns the email.
func (s *AuthService) EmailExists(email string) (bool, error) {
	u, err := s.users.GetByEmail(s.db, email)
	if err != nil {
		return false, err
	}
	return u != nil, nil
}

// InsertLoginAttempt writes the login audit row.
func (s *AuthService) InsertLoginAttempt(la *model.LoginAttempt) error {
	return repo.NewLoginAttemptRepo().Insert(s.db, la)
}

// EncryptField exposes AES-GCM encryption to callers storing secrets
// (bilibili SESSDATA, wechat tokens).
func (s *AuthService) EncryptField(plain string) (string, error) {
	return s.cipher.Encrypt(plain)
}

// EnsureUserFromOAuth finds or creates a user via OAuth binding and issues a
// session token. Idempotent per (provider, providerUID).
func (s *AuthService) EnsureUserFromOAuth(provider, providerUID string, data *ProviderData,
	profile *ProfilePatch, deviceID, ip, userAgent *string) (int64, string, error) {
	existing, err := s.oauth.GetByProvider(s.db, provider, providerUID)
	if err != nil {
		return 0, "", err
	}
	var uid int64
	if existing != nil {
		if err := s.CheckActive(context.Background(), existing.UID); err != nil {
			return 0, "", err
		}
		uid = existing.UID
		if data != nil {
			at, rt, err := s.encryptTokens(data)
			if err != nil {
				return 0, "", err
			}
			if err := s.oauth.UpdateTokens(s.db, existing.ID, at, rt); err != nil {
				return 0, "", err
			}
			s.invalidateBiliCreds(uid)
		}
		if profile != nil {
			if err := s.applyProfilePatch(uid, profile); err != nil {
				return 0, "", err
			}
		}
		slog.Info("[USER] existing user", "uid", uid, "provider", provider)
	} else {
		uid = s.sf.Next()
		status := "active"
		if err := s.users.Create(s.db, &model.User{UID: uid, Status: &status}, nil); err != nil {
			return 0, "", err
		}
		var at, rt *string
		if data != nil {
			if at, rt, err = s.encryptTokens(data); err != nil {
				return 0, "", err
			}
		}
		primary := true
		row := &model.UserOAuth{
			UID:         uid,
			Provider:    provider,
			ProviderUID: providerUID,
			IsPrimary:   &primary,
		}
		if data != nil {
			if data.AccessToken != "" {
				row.AccessToken = at
			}
			if data.RefreshToken != "" {
				row.RefreshToken = rt
			}
			if data.ExpiresAt != nil {
				row.ExpiresAt = data.ExpiresAt
			}
			if data.RawData != "" {
				row.RawData = &data.RawData
			}
			if data.UnionID != "" {
				row.UnionID = &data.UnionID
			}
		}
		if err := s.oauth.Create(s.db, row); err != nil {
			return 0, "", err
		}
		if err := s.applyProfilePatch(uid, profile); err != nil {
			return 0, "", err
		}
		if err := s.grantDefaultRole(uid); err != nil {
			return 0, "", err
		}
		slog.Info("[USER] created user", "uid", uid, "provider", provider)
	}

	s.invalidateBiliStatus(uid)

	token, err := s.tokens.Issue(context.Background(), uid, deviceID, ip, userAgent)
	if err != nil {
		return 0, "", err
	}
	return uid, token, nil
}

// BindOAuthToUser binds (or refreshes) a third-party binding on an existing
// user. Refuses bindings owned by another user.
func (s *AuthService) BindOAuthToUser(uid int64, provider, providerUID string,
	data *ProviderData, profile *ProfilePatch) error {
	if err := s.CheckActive(context.Background(), uid); err != nil {
		return err
	}
	s.invalidateBiliStatus(uid) // a bind/refresh must not serve a stale cached status
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}

	existing, err := s.oauth.GetByProvider(s.db, provider, providerUID)
	if err != nil {
		return err
	}
	var at, rt *string
	if data != nil {
		if at, rt, err = s.encryptTokens(data); err != nil {
			return err
		}
	}
	if existing != nil {
		if existing.UID != uid {
			return ErrOAuthBoundOther
		}
		if err := s.oauth.UpdateTokens(s.db, existing.ID, at, rt); err != nil {
			return err
		}
		s.invalidateBiliCreds(uid)
		return nil
	}
	current, err := s.oauth.GetByUIDProvider(s.db, uid, provider)
	if err != nil {
		return err
	}
	if current != nil {
		// Same provider already bound to a different platform account —
		// re-point the binding (parity with Python update_binding).
		if err := s.oauth.SoftDelete(s.db, current.ID); err != nil {
			return err
		}
	}
	row := &model.UserOAuth{UID: uid, Provider: provider, ProviderUID: providerUID}
	if data != nil {
		if data.AccessToken != "" && at != nil {
			row.AccessToken = at
		}
		if data.RefreshToken != "" && rt != nil {
			row.RefreshToken = rt
		}
		if data.ExpiresAt != nil {
			row.ExpiresAt = data.ExpiresAt
		}
		if data.RawData != "" {
			row.RawData = &data.RawData
		}
		if data.UnionID != "" {
			row.UnionID = &data.UnionID
		}
	}
	if err := s.oauth.Create(s.db, row); err != nil {
		return err
	}
	s.invalidateBiliCreds(uid)
	if profile != nil {
		if err := s.applyProfilePatch(uid, profile); err != nil {
			return err
		}
	}
	slog.Info("[USER] bound oauth", "uid", uid, "provider", provider, "provider_uid", providerUID)
	return nil
}

// RegisterWithEmail creates a password account with a pre-verified email
// (caller consumed the register-purpose code) and issues a session token.
func (s *AuthService) RegisterWithEmail(email, password string, deviceID, ip, userAgent *string) (int64, string, error) {
	if err := validatePasswordForUser(password, &email, nil); err != nil {
		return 0, "", err
	}
	existing, err := s.users.GetByEmail(s.db, email)
	if err != nil {
		return 0, "", err
	}
	if existing != nil {
		return 0, "", ErrEmailTaken
	}
	uid := s.sf.Next()
	status := "active"
	verified := true
	hash, err := security.HashPassword(password)
	if err != nil {
		return 0, "", err
	}
	u := &model.User{
		UID:           uid,
		Status:        &status,
		Email:         &email,
		PasswordHash:  &hash,
		EmailVerified: &verified,
	}
	if err := s.users.Create(s.db, u, &model.UserProfile{UID: uid}); err != nil {
		// unique(email) race → treat as taken
		if strings.Contains(err.Error(), "Duplicate entry") {
			return 0, "", ErrEmailTaken
		}
		return 0, "", err
	}
	if err := s.grantDefaultRole(uid); err != nil {
		return 0, "", err
	}
	token, err := s.tokens.Issue(context.Background(), uid, deviceID, ip, userAgent)
	if err != nil {
		return 0, "", err
	}
	slog.Info("[USER] registered via email", "uid", uid)
	return uid, token, nil
}

// LoginOrRegisterByPhone — SMS-code login; registers on first use.
func (s *AuthService) LoginOrRegisterByPhone(phone string, deviceID, ip, userAgent *string) (int64, string, bool, error) {
	user, err := s.users.GetByPhone(s.db, phone)
	if err != nil {
		return 0, "", false, err
	}
	if user != nil {
		if !isActiveStatus(user.Status) {
			return 0, "", false, ErrAccountDisabled
		}
		token, err := s.tokens.Issue(context.Background(), user.UID, deviceID, ip, userAgent)
		slog.Info("[USER] phone login", "uid", user.UID)
		return user.UID, token, false, err
	}
	uid := s.sf.Next()
	status := "active"
	verified := true
	u := &model.User{UID: uid, Status: &status, Phone: &phone, PhoneVerified: &verified}
	if err := s.users.Create(s.db, u, &model.UserProfile{UID: uid}); err != nil {
		if strings.Contains(err.Error(), "Duplicate entry") {
			return 0, "", false, ErrPhoneTaken
		}
		return 0, "", false, err
	}
	if err := s.grantDefaultRole(uid); err != nil {
		return 0, "", false, err
	}
	token, err := s.tokens.Issue(context.Background(), uid, deviceID, ip, userAgent)
	if err != nil {
		return 0, "", false, err
	}
	slog.Info("[USER] registered via phone", "uid", uid)
	return uid, token, true, nil
}

// LoginWithPassword — email OR phone + password.
func (s *AuthService) LoginWithPassword(identifier, password string, deviceID, ip, userAgent *string) (int64, string, error) {
	user, err := s.users.GetByEmail(s.db, identifier)
	if err != nil {
		return 0, "", err
	}
	if user == nil {
		user, err = s.users.GetByPhone(s.db, identifier)
		if err != nil {
			return 0, "", err
		}
	}
	if user == nil || user.PasswordHash == nil {
		// Burn one bcrypt comparison so a missing account is not measurably
		// faster than a wrong password (account enumeration defense).
		security.DummyVerify(password)
		return 0, "", ErrAccountNoPassword
	}
	if !isActiveStatus(user.Status) {
		return 0, "", ErrAccountDisabled
	}
	if !security.VerifyPassword(password, *user.PasswordHash) {
		return 0, "", ErrPasswordWrong
	}
	token, err := s.tokens.Issue(context.Background(), user.UID, deviceID, ip, userAgent)
	if err != nil {
		return 0, "", err
	}
	slog.Info("[USER] password login", "uid", user.UID)
	return user.UID, token, nil
}

// UserInfo is the GET /auth/me shape (plus token fields for login flows).
type UserInfo struct {
	UID       int64      `json:"uid"`
	Nickname  *string    `json:"nickname"`
	Avatar    *string    `json:"avatar"`
	Status    string     `json:"status"`
	Roles     []string   `json:"roles"`
	CreatedAt *time.Time `json:"created_at"`
}

func (s *AuthService) invalidateBiliCreds(uid int64) {
	if s.invalidateCreds != nil {
		s.invalidateCreds(uid)
	}
}

// grantDefaultRole grants the free role and invalidates the role cache.
func (s *AuthService) grantDefaultRole(uid int64) error {
	if err := s.grantDefaultRole(uid); err != nil {
		return err
	}
	if s.authz != nil {
		s.authz.DeleteRoles(context.Background(), uid)
	}
	return nil
}

// GetUserByUID assembles user info (users + profile + roles) in ONE query.
func (s *AuthService) GetUserByUID(uid int64) (*UserInfo, error) {
	row, err := s.users.GetUserInfo(s.db, uid)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	info := &UserInfo{UID: row.UID, Roles: splitRoles(row.Roles), CreatedAt: row.CreatedAt}
	if row.Status != nil {
		info.Status = *row.Status
	} else {
		info.Status = "active"
	}
	info.Nickname = row.Nickname
	info.Avatar = NormalizeAvatarURL(row.Avatar)
	return info, nil
}

func splitRoles(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// CheckActive enforces the account status gate. The result is cached in the
// authz cache (60s) so the forward-auth hot path does not query MySQL on every
// request; a manual ban takes effect within one TTL even without invalidation.
func (s *AuthService) CheckActive(ctx context.Context, uid int64) error {
	if uid <= 0 {
		return ErrAccountDisabled
	}
	status, deleted, ok := "", false, false
	if s.authz != nil {
		status, deleted, ok = s.authz.GetStatus(ctx, uid)
	}
	if !ok {
		st, del, err := s.users.GetStatus(s.db, uid)
		if err != nil {
			return err
		}
		status, deleted = st, del
		if s.authz != nil {
			s.authz.SetStatus(ctx, uid, status, deleted)
		}
	}
	if deleted || !isActiveStatus(&status) {
		return ErrAccountDisabled
	}
	return nil
}

// Authorize returns the active roles for uid with the same cache, used by the
// APISIX forward-auth verify endpoint (0 SQL on the steady-state hot path).
func (s *AuthService) Authorize(ctx context.Context, uid int64) ([]string, error) {
	if err := s.CheckActive(ctx, uid); err != nil {
		return nil, err
	}
	if s.authz != nil {
		if roles, ok := s.authz.GetRoles(ctx, uid); ok {
			return roles, nil
		}
	}
	roles, err := s.rbac.GetUserRoles(s.db, uid)
	if err != nil {
		return nil, err
	}
	if s.authz != nil {
		s.authz.SetRoles(ctx, uid, roles)
	}
	return roles, nil
}

// RequireStepUp protects security-sensitive account changes (binding a new
// email/phone/login method). If the account has a password, the caller must
// present it. Accounts without a password but with an already-verified contact
// must set a password first (otherwise a stolen session could silently attach
// an attacker-controlled recovery address and then reset the password).
func (s *AuthService) RequireStepUp(uid int64, currentPassword string) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.PasswordHash != nil {
		if currentPassword == "" || !security.VerifyPassword(currentPassword, *user.PasswordHash) {
			return ErrStepUpRequired
		}
		return nil
	}
	if (user.EmailVerified != nil && *user.EmailVerified) || (user.PhoneVerified != nil && *user.PhoneVerified) {
		return ErrSetPasswordFirst
	}
	return nil
}

// FullProfile is the GET/PATCH /auth/profile shape.
type FullProfile struct {
	UID           int64      `json:"uid"`
	Email         *string    `json:"email"`
	EmailVerified bool       `json:"email_verified"`
	Phone         *string    `json:"phone"`
	PhoneVerified bool       `json:"phone_verified"`
	Nickname      *string    `json:"nickname"`
	Avatar        *string    `json:"avatar"`
	Bio           *string    `json:"bio"`
	Birthday      *string    `json:"birthday"`
	Gender        *string    `json:"gender"`
	Location      *string    `json:"location"`
	Timezone      *string    `json:"timezone"`
	Language      *string    `json:"language"`
	Status        string     `json:"status"`
	CreatedAt     *time.Time `json:"created_at"`
}

// InternalUserContact returns email/status for /internal/auth/user/{uid} (M2M).
func (s *AuthService) InternalUserContact(uid int64) (email, status string, ok bool, err error) {
	u, err := s.users.InternalContact(s.db, uid)
	if err != nil || u == nil {
		return "", "", false, err
	}
	if u.Email != nil {
		email = *u.Email
	}
	if u.Status != nil {
		status = *u.Status
	}
	return email, status, true, nil
}

func (s *AuthService) GetFullProfile(uid int64) (*FullProfile, error) {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, nil
	}
	profile, err := s.users.GetProfile(s.db, uid)
	if err != nil {
		return nil, err
	}
	p := &FullProfile{UID: user.UID}
	if user.Email != nil {
		p.Email = user.Email
	}
	p.EmailVerified = user.EmailVerified != nil && *user.EmailVerified
	if user.Phone != nil {
		p.Phone = user.Phone
	}
	p.PhoneVerified = user.PhoneVerified != nil && *user.PhoneVerified
	if profile != nil {
		p.Nickname = profile.Nickname
		p.Avatar = NormalizeAvatarURL(profile.Avatar)
		p.Bio = profile.Bio
		if profile.Birthday != nil {
			b := profile.Birthday.Format("2006-01-02")
			p.Birthday = &b
		}
		p.Gender = profile.Gender
		p.Location = profile.Location
		p.Timezone = profile.Timezone
		p.Language = profile.Language
	}
	if user.Status != nil {
		p.Status = *user.Status
	} else {
		p.Status = "active"
	}
	p.CreatedAt = user.CreatedAt
	return p, nil
}

// UpdateProfile patches the profile columns present in fields, then returns
// the refreshed profile.
func (s *AuthService) UpdateProfile(uid int64, fields map[string]any) (*FullProfile, error) {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, nil
	}
	profileKeys := map[string]bool{
		"nickname": true, "avatar": true, "bio": true, "birthday": true,
		"gender": true, "location": true, "timezone": true, "language": true,
	}
	patch := map[string]any{}
	for k, v := range fields {
		if profileKeys[k] && v != nil {
			patch[k] = v
		}
	}
	if len(patch) > 0 {
		if err := s.users.UpdateProfileFields(s.db, uid, patch); err != nil {
			return nil, err
		}
	}
	return s.GetFullProfile(uid)
}

// ── Passwords ────────────────────────────────────────────────────────

// recordSecurityEvent writes an audit row (best-effort; never blocks the
// credential change itself).
func (s *AuthService) recordSecurityEvent(uid int64, event, detail string) {
	if s.events == nil {
		return
	}
	ev := &model.SecurityEvent{UID: uid, Event: event, CreatedAt: time.Now()}
	if detail != "" {
		d := detail
		ev.Detail = &d
	}
	if err := s.events.Insert(s.db, ev); err != nil {
		slog.Warn("[USER] security event insert failed", "uid", uid, "event", event, "err", err)
	}
}

// rememberPassword stores the previous hash so the next N changes can reject
// reuse. Failure only weakens history checking; it is logged, not fatal.
func (s *AuthService) rememberPassword(uid int64, hash string) {
	if hash == "" || s.passwords == nil {
		return
	}
	if err := s.passwords.Insert(s.db, uid, hash); err != nil {
		slog.Warn("[USER] password history insert failed", "uid", uid, "err", err)
	}
}

// ensurePasswordNotReused rejects the current password and the last 5 hashes.
func (s *AuthService) ensurePasswordNotReused(user *model.User, newPassword string) error {
	if user.PasswordHash != nil && security.VerifyPassword(newPassword, *user.PasswordHash) {
		return ErrSamePassword
	}
	if s.passwords == nil {
		return nil
	}
	hashes, err := s.passwords.ListRecent(s.db, user.UID, 5)
	if err != nil {
		slog.Warn("[USER] password history read failed", "uid", user.UID, "err", err)
		return nil
	}
	for _, hash := range hashes {
		if security.VerifyPassword(newPassword, hash) {
			return ErrPasswordReused
		}
	}
	return nil
}

func (s *AuthService) SetPassword(uid int64, password string) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.PasswordHash != nil {
		return ErrPasswordExists
	}
	if err := validatePasswordForUser(password, user.Email, user.Phone); err != nil {
		return err
	}
	hash, err := security.HashPassword(password)
	if err != nil {
		return err
	}
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"password_hash": hash}); err != nil {
		return err
	}
	s.recordSecurityEvent(uid, "password_set", "")
	slog.Info("[USER] password set", "uid", uid)
	return nil
}

func (s *AuthService) ChangePassword(uid int64, oldPassword, newPassword string) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.PasswordHash == nil {
		return ErrNoPassword
	}
	if err := validatePasswordForUser(newPassword, user.Email, user.Phone); err != nil {
		return err
	}
	if oldPassword == newPassword {
		return ErrSamePassword
	}
	if !security.VerifyPassword(oldPassword, *user.PasswordHash) {
		return ErrOldPasswordWrong
	}
	if err := s.ensurePasswordNotReused(user, newPassword); err != nil {
		return err
	}
	hash, err := security.HashPassword(newPassword)
	if err != nil {
		return err
	}
	oldHash := *user.PasswordHash
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"password_hash": hash}); err != nil {
		return err
	}
	s.rememberPassword(uid, oldHash)
	s.recordSecurityEvent(uid, "password_changed", "")
	slog.Info("[USER] password changed", "uid", uid)
	return nil
}

func (s *AuthService) ResetPassword(uid int64, newPassword string) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if err := validatePasswordForUser(newPassword, user.Email, user.Phone); err != nil {
		return err
	}
	if err := s.ensurePasswordNotReused(user, newPassword); err != nil {
		return err
	}
	hash, err := security.HashPassword(newPassword)
	if err != nil {
		return err
	}
	var oldHash string
	if user.PasswordHash != nil {
		oldHash = *user.PasswordHash
	}
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"password_hash": hash}); err != nil {
		return err
	}
	s.rememberPassword(uid, oldHash)
	s.recordSecurityEvent(uid, "password_reset", "")
	slog.Info("[USER] password reset", "uid", uid)
	return nil
}

// ── Email / phone binding ────────────────────────────────────────────

func (s *AuthService) BindEmail(uid int64, email string) error {
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"email": email, "email_verified": false}); err != nil {
		if strings.Contains(err.Error(), "Duplicate entry") {
			return ErrEmailBound
		}
		return err
	}
	s.recordSecurityEvent(uid, "email_bound", maskEmail(email))
	slog.Info("[USER] email bound", "uid", uid)
	return nil
}

func (s *AuthService) ApplyVerifiedEmail(uid int64, email string) error {
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"email": email, "email_verified": true}); err != nil {
		if strings.Contains(err.Error(), "Duplicate entry") {
			return ErrEmailBound
		}
		return err
	}
	s.recordSecurityEvent(uid, "email_verified", maskEmail(email))
	slog.Info("[USER] email verified", "uid", uid)
	return nil
}

func (s *AuthService) BindPhone(uid int64, phone string) error {
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"phone": phone, "phone_verified": false}); err != nil {
		if strings.Contains(err.Error(), "Duplicate entry") {
			return ErrPhoneBound
		}
		return err
	}
	s.recordSecurityEvent(uid, "phone_bound", maskPhone(phone))
	slog.Info("[USER] phone bound", "uid", uid)
	return nil
}

func (s *AuthService) ApplyVerifiedPhone(uid int64, phone string) error {
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"phone": phone, "phone_verified": true}); err != nil {
		if strings.Contains(err.Error(), "Duplicate entry") {
			return ErrPhoneBound
		}
		return err
	}
	s.recordSecurityEvent(uid, "phone_verified", maskPhone(phone))
	slog.Info("[USER] phone verified", "uid", uid)
	return nil
}

func (s *AuthService) UnbindEmail(uid int64) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.Email == nil {
		return nil
	}
	if err := s.checkCanUnbind(user); err != nil {
		return err
	}
	detail := ""
	if user.Email != nil {
		detail = maskEmail(*user.Email)
	}
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"email": nil, "email_verified": false}); err != nil {
		return err
	}
	s.recordSecurityEvent(uid, "email_unbound", detail)
	return nil
}

func (s *AuthService) UnbindPhone(uid int64) error {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.Phone == nil {
		return nil
	}
	if err := s.checkCanUnbind(user); err != nil {
		return err
	}
	detail := ""
	if user.Phone != nil {
		detail = maskPhone(*user.Phone)
	}
	if err := s.users.SetUserFields(s.db, uid, map[string]any{"phone": nil, "phone_verified": false}); err != nil {
		return err
	}
	s.recordSecurityEvent(uid, "phone_unbound", detail)
	return nil
}

func (s *AuthService) checkCanUnbind(user *model.User) error {
	remaining := 0
	if user.PasswordHash != nil {
		remaining++
	}
	bindings, err := s.oauth.ListByUID(s.db, user.UID)
	if err != nil {
		return err
	}
	remaining += len(bindings)
	if remaining <= 1 {
		return ErrCantUnbind
	}
	return nil
}

// ── Devices ──────────────────────────────────────────────────────────

// RecordDevice upserts the user_device row with one statement (best-effort
// error handling, but it is a synchronous write on the login path).
func (s *AuthService) RecordDevice(uid int64, deviceID string, meta utils.DeviceMeta) {
	if deviceID == "" {
		return
	}
	row := &model.UserDevice{
		DeviceID: deviceID,
		UID:      uid,
	}
	row.DeviceType = meta.DeviceType
	row.DeviceName = meta.DeviceName
	row.OS = meta.OS
	row.OSVersion = meta.OSVersion
	row.Browser = meta.Browser
	row.BrowserVersion = meta.BrowserVersion
	if err := s.devices.Upsert(s.db, row); err != nil {
		slog.Warn("[USER] record device failed", "uid", uid, "err", err)
	}
}

// ListDevices returns the user's devices.
func (s *AuthService) ListDevices(uid int64) ([]model.UserDevice, error) {
	return s.devices.ListByUID(s.db, uid)
}

// ── Security overview ────────────────────────────────────────────────

// BilibiliStatus is the bilibili block of GET /auth/security.
type BilibiliStatus struct {
	Bound    bool    `json:"bound"`
	Valid    bool    `json:"valid"`
	Mid      *int64  `json:"mid"`
	Nickname *string `json:"nickname"`
	Avatar   *string `json:"avatar"`
	Message  string  `json:"message"`
}

// SecurityOverview is the GET /auth/security shape.
type SecurityOverview struct {
	Email         *string          `json:"email"`
	EmailVerified bool             `json:"email_verified"`
	Phone         *string          `json:"phone"`
	PhoneVerified bool             `json:"phone_verified"`
	HasPassword   bool             `json:"has_password"`
	OAuthBindings []map[string]any `json:"oauth_bindings"`
	Bilibili      BilibiliStatus   `json:"bilibili"`
}

func (s *AuthService) GetSecurityInfo(uid int64, passport *BilibiliPassport) (*SecurityOverview, error) {
	user, err := s.users.GetByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrUserNotFound
	}
	bindings, err := s.oauth.ListByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	out := &SecurityOverview{
		Email:         user.Email,
		EmailVerified: user.EmailVerified != nil && *user.EmailVerified,
		Phone:         user.Phone,
		PhoneVerified: user.PhoneVerified != nil && *user.PhoneVerified,
		HasPassword:   user.PasswordHash != nil,
		OAuthBindings: []map[string]any{},
		Bilibili: BilibiliStatus{
			Message: "未绑定B站账号",
		},
	}
	for _, b := range bindings {
		primary := b.IsPrimary != nil && *b.IsPrimary
		out.OAuthBindings = append(out.OAuthBindings, map[string]any{
			"provider":   b.Provider,
			"email":      b.Email,
			"is_primary": primary,
		})
		if b.Provider == "bilibili" {
			out.Bilibili = s.bilibiliStatusCached(uid, &b, passport)
		}
	}
	return out, nil
}

// bilibiliStatusCached wraps the live B站 check with a per-uid TTL cache and a
// hard deadline. GET /auth/security is on the account page's critical path; the
// upstream call was observed taking 2–8s (api.bilibili.com reachability), which
// made the whole page wait on it.
func (s *AuthService) bilibiliStatusCached(uid int64, b *model.UserOAuth, passport *BilibiliPassport) BilibiliStatus {
	s.biliMu.Lock()
	if entry, ok := s.biliCache[uid]; ok && time.Since(entry.at) < biliStatusTTL {
		s.biliMu.Unlock()
		return entry.status
	}
	s.biliMu.Unlock()

	ch := make(chan BilibiliStatus, 1)
	go func() { ch <- s.bilibiliStatus(b, passport) }()

	select {
	case st := <-ch:
		s.biliMu.Lock()
		if len(s.biliCache) > 5000 {
			s.biliCache = make(map[int64]biliCacheEntry)
		}
		s.biliCache[uid] = biliCacheEntry{status: st, at: time.Now()}
		s.biliMu.Unlock()
		return st
	case <-time.After(biliStatusTimeout):
		st := BilibiliStatus{Bound: true, Valid: false, Message: "B站状态检查超时，请稍后重试"}
		if isDigits(b.ProviderUID) {
			mid := parseInt64(b.ProviderUID)
			st.Mid = &mid
		}
		// not cached: the next open retries the live check
		return st
	}
}

// invalidateBiliStatus drops the cached binding status (called on bind/unbind).
func (s *AuthService) invalidateBiliStatus(uid int64) {
	s.biliMu.Lock()
	delete(s.biliCache, uid)
	s.biliMu.Unlock()
}

func (s *AuthService) bilibiliStatus(b *model.UserOAuth, passport *BilibiliPassport) BilibiliStatus {
	status := BilibiliStatus{Bound: true, Message: "B站登录已失效，请重新扫码"}
	if isDigits(b.ProviderUID) {
		mid := parseInt64(b.ProviderUID)
		status.Mid = &mid
	}
	if b.AccessToken == nil {
		return status
	}
	sessdata, err := s.cipher.Decrypt(*b.AccessToken)
	if err != nil {
		slog.Warn("[USER] bilibili binding decrypt failed", "uid", b.UID, "err", err)
		return status
	}
	info, err := passport.GetUserInfo(sessdata, "", b.ProviderUID)
	if err != nil {
		slog.Warn("[USER] bilibili binding invalid", "uid", b.UID, "err", err)
		return status
	}
	status.Valid = true
	status.Message = "B站账号已绑定"
	if info.Mid != 0 {
		status.Mid = &info.Mid
	}
	status.Nickname = &info.Uname
	status.Avatar = &info.Face
	return status
}

// ── helpers ──────────────────────────────────────────────────────────

func (s *AuthService) encryptTokens(data *ProviderData) (*string, *string, error) {
	if data == nil {
		return nil, nil, nil
	}
	var at, rt *string
	if data.AccessToken != "" {
		enc, err := s.cipher.Encrypt(data.AccessToken)
		if err != nil {
			return nil, nil, err
		}
		at = &enc
	}
	if data.RefreshToken != "" {
		enc, err := s.cipher.Encrypt(data.RefreshToken)
		if err != nil {
			return nil, nil, err
		}
		rt = &enc
	}
	return at, rt, nil
}

func (s *AuthService) applyProfilePatch(uid int64, p *ProfilePatch) error {
	if p == nil {
		return nil
	}
	fields := map[string]any{}
	if p.Nickname != nil {
		fields["nickname"] = *p.Nickname
	}
	if p.Avatar != nil {
		fields["avatar"] = *p.Avatar
	}
	if p.Bio != nil {
		fields["bio"] = *p.Bio
	}
	if len(fields) == 0 {
		return nil
	}
	return s.users.UpdateProfileFields(s.db, uid, fields)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseInt64(s string) int64 {
	var v int64
	for _, r := range s {
		v = v*10 + int64(r-'0')
	}
	return v
}
