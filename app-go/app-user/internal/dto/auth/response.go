package auth

import "time"

// ── Shared envelopes ─────────────────────────────────────────────────

// Message is the shared {"message": ...} success envelope.
type Message struct {
	Message string `json:"message"`
}

// UserInfo is the public account summary (GET /auth/me, token responses).
type UserInfo struct {
	UID      int64    `json:"uid"`
	Nickname *string  `json:"nickname"`
	Avatar   *string  `json:"avatar"`
	Status   string   `json:"status"`
	Roles    []string `json:"roles"`
}

// Token is a successful login response (TokenResponse shape).
type Token struct {
	SessionToken string     `json:"session_token"`
	TokenType    string     `json:"token_type"`
	ExpiresAt    *time.Time `json:"expires_at"`
	UserInfo     UserInfo   `json:"user_info"`
}

// ── Public login surface ─────────────────────────────────────────────

// Features is GET /auth/features (enabled login channels).
type Features struct {
	EmailRegisterEnabled bool `json:"email_register_enabled"`
	SMSEnabled           bool `json:"sms_enabled"`
}

// Captcha is GET /auth/captcha.
type Captcha struct {
	CaptchaID   string `json:"captcha_id"`
	ImageBase64 string `json:"image_base64"`
	ExpiresIn   int    `json:"expires_in"`
	Required    bool   `json:"required"`
}

// QRCode is GET /auth/qrcode.
type QRCode struct {
	QRCodeKey         string `json:"qrcode_key"`
	QRCodeURL         string `json:"qrcode_url"`
	QRCodeImageBase64 string `json:"qrcode_image_base64"`
}

// QRCodePoll is GET /auth/qrcode/poll/{qrcode_key}. session_id and user_info
// only appear once the scan is confirmed.
type QRCodePoll struct {
	Status    string      `json:"status"`
	Message   string      `json:"message"`
	SessionID string      `json:"session_id,omitempty"`
	UserInfo  *QRCodeUser `json:"user_info,omitempty"`
}

// QRCodeUser is the user_info block of a confirmed QR-code poll. The bind
// branch carries roles only; the login branch also carries session_token.
type QRCodeUser struct {
	UID          int64    `json:"uid"`
	Mid          int64    `json:"mid"`
	Uname        *string  `json:"uname"`
	Face         *string  `json:"face"`
	Roles        []string `json:"roles"`
	SessionToken string   `json:"session_token,omitempty"`
}

// AttestChallenge is GET /auth/attest/challenge.
type AttestChallenge struct {
	Challenge string `json:"challenge"`
	ExpiresIn int    `json:"expires_in"`
}

// AttestTicket is POST /auth/attest.
type AttestTicket struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expires_in"`
}

// WeChatOptions is GET /auth/wechat/qrcode.
type WeChatOptions struct {
	Enabled     bool   `json:"enabled"`
	AppID       string `json:"app_id"`
	RedirectURI string `json:"redirect_uri"`
	State       string `json:"state"`
}

// ── Account surface ──────────────────────────────────────────────────

// Session is one active session in GET /auth/tokens.
type Session struct {
	SessionID    string     `json:"session_id"`
	DeviceID     *string    `json:"device_id"`
	IP           *string    `json:"ip"`
	UserAgent    *string    `json:"user_agent"`
	CreatedAt    *time.Time `json:"created_at"`
	LastActiveAt *time.Time `json:"last_active_at"`
	ExpiresAt    *time.Time `json:"expires_at"`
	IsCurrent    bool       `json:"is_current"`
}

// Sessions is GET /auth/tokens.
type Sessions struct {
	Sessions []Session `json:"sessions"`
}

// Device is one row in GET /auth/devices.
type Device struct {
	DeviceID       string     `json:"device_id"`
	DeviceType     *string    `json:"device_type"`
	DeviceName     *string    `json:"device_name"`
	OS             *string    `json:"os"`
	OSVersion      *string    `json:"os_version"`
	Browser        *string    `json:"browser"`
	BrowserVersion *string    `json:"browser_version"`
	TrustLevel     *string    `json:"trust_level"`
	LastActiveAt   *time.Time `json:"last_active_at"`
	CreatedAt      *time.Time `json:"created_at"`
	IsCurrent      bool       `json:"is_current"`
}

// Devices is GET /auth/devices.
type Devices struct {
	Devices []Device `json:"devices"`
}

// Profile is GET/PATCH /auth/profile.
type Profile struct {
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

// ChangePassword is PATCH /auth/password.
type ChangePassword struct {
	Message              string `json:"message"`
	OtherSessionsRevoked bool   `json:"other_sessions_revoked"`
}

// BindEmail is PUT /auth/email.
type BindEmail struct {
	Message string `json:"message"`
	Email   string `json:"email"`
}

// BindPhone is PUT /auth/phone and POST /auth/phone/verify.
type BindPhone struct {
	Message string `json:"message"`
	Phone   string `json:"phone"`
}

// VerifyEmail is POST /auth/email/verify.
type VerifyEmail struct {
	Message string `json:"message"`
	Email   string `json:"email"`
	Purpose string `json:"purpose"`
}

// BilibiliStatus is the bilibili block of GET /auth/security.
type BilibiliStatus struct {
	Bound    bool    `json:"bound"`
	Valid    bool    `json:"valid"`
	Mid      *int64  `json:"mid"`
	Nickname *string `json:"nickname"`
	Avatar   *string `json:"avatar"`
	Message  string  `json:"message"`
}

// Security is GET /auth/security.
type Security struct {
	Email         *string          `json:"email"`
	EmailVerified bool             `json:"email_verified"`
	Phone         *string          `json:"phone"`
	PhoneVerified bool             `json:"phone_verified"`
	HasPassword   bool             `json:"has_password"`
	OAuthBindings []map[string]any `json:"oauth_bindings"`
	Bilibili      BilibiliStatus   `json:"bilibili"`
}

// ── Internal (M2M) surface ───────────────────────────────────────────

// InternalUser is GET /internal/auth/user/{uid}.
type InternalUser struct {
	UID    int64  `json:"uid"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

// InternalVerify is GET /internal/auth/verify. uid is omitted for anonymous
// requests (ok=false) exactly like the legacy gateway handshake.
type InternalVerify struct {
	OK  bool  `json:"ok"`
	UID int64 `json:"uid,omitempty"`
}

// ── Coding Plan ──────────────────────────────────────────────────────
// Moved to internal/dto/settings (settings domain, /settings/coding-plans).

// QRPollResult is the outcome of one QR-code poll call. It carries the
// session cookies and refresh token between the passport client and the
// router; those fields are never serialized to the end user.
type QRPollResult struct {
	Status       string
	Message      string
	Cookies      map[string]string
	RefreshToken string
}
