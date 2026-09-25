// Package model mirrors the auth tables owned by app-auth in the shared
// bilirag MySQL database. Column names/types MUST match the existing schema
// (app/system.sql + app/models.py) exactly — the tables already hold live
// data and the Python backend keeps read access to user_oauth.
package model

import "time"

// User — core account row (uid is a snowflake id, not auto-increment in
// practice; system.sql declares auto_increment but inserts always supply uid).
type User struct {
	UID           int64      `gorm:"column:uid;primaryKey" json:"uid"`
	Status        *string    `gorm:"column:status" json:"status"`
	CreatedAt     *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt     *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt     *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
	Email         *string    `gorm:"column:email" json:"email"`
	Phone         *string    `gorm:"column:phone" json:"phone"`
	PasswordHash  *string    `gorm:"column:password_hash" json:"-"`
	EmailVerified *bool      `gorm:"column:email_verified" json:"email_verified"`
	PhoneVerified *bool      `gorm:"column:phone_verified" json:"phone_verified"`
}

func (User) TableName() string { return "users" }

// UserOAuth — third-party login binding. access_token/refresh_token hold
// AES-256-GCM ciphertext (see internal/security). The Python backend READS
// the bilibili row (SESSDATA) for business APIs; app-auth owns all writes.
type UserOAuth struct {
	ID           int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID          int64      `gorm:"column:uid" json:"uid"`
	Provider     string     `gorm:"column:provider" json:"provider"`
	ProviderUID  string     `gorm:"column:provider_uid" json:"provider_uid"`
	Email        *string    `gorm:"column:email" json:"email"`
	UnionID      *string    `gorm:"column:union_id" json:"union_id"`
	AccessToken  *string    `gorm:"column:access_token" json:"-"`
	RefreshToken *string    `gorm:"column:refresh_token" json:"-"`
	ExpiresAt    *time.Time `gorm:"column:expires_at" json:"expires_at"`
	RawData      *string    `gorm:"column:raw_data" json:"-"`
	IsPrimary    *bool      `gorm:"column:is_primary" json:"is_primary"`
	CreatedAt    *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt    *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt    *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (UserOAuth) TableName() string { return "user_oauth" }

// UserProfile — display profile, 1:1 with users.
type UserProfile struct {
	UID       int64      `gorm:"column:uid;primaryKey" json:"uid"`
	Nickname  *string    `gorm:"column:nickname" json:"nickname"`
	Avatar    *string    `gorm:"column:avatar" json:"avatar"`
	Bio       *string    `gorm:"column:bio" json:"bio"`
	Birthday  *time.Time `gorm:"column:birthday;type:date" json:"birthday"`
	Gender    *string    `gorm:"column:gender" json:"gender"`
	Location  *string    `gorm:"column:location" json:"location"`
	Timezone  *string    `gorm:"column:timezone" json:"timezone"`
	Language  *string    `gorm:"column:language" json:"language"`
	CreatedAt *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (UserProfile) TableName() string { return "user_profile" }

// UserToken — opaque session token (the bili_session the frontend stores).
type UserToken struct {
	SessionToken string     `gorm:"column:session_token;primaryKey" json:"session_token"`
	UID          int64      `gorm:"column:uid" json:"uid"`
	DeviceID     *string    `gorm:"column:device_id" json:"device_id"`
	TokenType    *string    `gorm:"column:token_type" json:"token_type"`
	ExpiresAt    *time.Time `gorm:"column:expires_at" json:"expires_at"`
	IP           *string    `gorm:"column:ip" json:"ip"`
	UserAgent    *string    `gorm:"column:user_agent" json:"user_agent"`
	IsRevoked    *bool      `gorm:"column:is_revoked" json:"is_revoked"`
	LastActiveAt *time.Time `gorm:"column:last_active_at" json:"last_active_at"`
	CreatedAt    *time.Time `gorm:"column:created_at" json:"created_at"`
	DeletedAt    *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (UserToken) TableName() string { return "user_tokens" }

// UserDevice — one row per known device fingerprint per user.
type UserDevice struct {
	DeviceID       string     `gorm:"column:device_id;primaryKey" json:"device_id"`
	UID            int64      `gorm:"column:uid" json:"uid"`
	DeviceType     *string    `gorm:"column:device_type" json:"device_type"`
	DeviceName     *string    `gorm:"column:device_name" json:"device_name"`
	OS             *string    `gorm:"column:os" json:"os"`
	OSVersion      *string    `gorm:"column:os_version" json:"os_version"`
	Browser        *string    `gorm:"column:browser" json:"browser"`
	BrowserVersion *string    `gorm:"column:browser_version" json:"browser_version"`
	Fingerprint    *string    `gorm:"column:fingerprint" json:"fingerprint"`
	TrustLevel     *string    `gorm:"column:trust_level" json:"trust_level"`
	LastActiveAt   *time.Time `gorm:"column:last_active_at" json:"last_active_at"`
	CreatedAt      *time.Time `gorm:"column:created_at" json:"created_at"`
	DeletedAt      *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (UserDevice) TableName() string { return "user_device" }

// VerificationCode — email/phone one-time codes (MySQL-backed, not Redis).
type VerificationCode struct {
	ID        int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID       *int64     `gorm:"column:uid" json:"uid"`
	Target    string     `gorm:"column:target" json:"target"`
	Type      string     `gorm:"column:type" json:"type"`
	Purpose   string     `gorm:"column:purpose" json:"purpose"`
	Code      string     `gorm:"column:code" json:"code"`
	ExpiresAt time.Time  `gorm:"column:expires_at" json:"expires_at"`
	Used      *bool      `gorm:"column:used" json:"used"`
	Attempts  *int       `gorm:"column:attempts" json:"attempts"`
	CreatedAt *time.Time `gorm:"column:created_at" json:"created_at"`
}

func (VerificationCode) TableName() string { return "verification_codes" }

// LoginAttempt — one row per /auth/login call (success or failure), used for
// failure counting, cooldown and audit.
type LoginAttempt struct {
	ID            int64     `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID           *int64    `gorm:"column:uid" json:"uid"`
	Email         *string   `gorm:"column:email" json:"email"`
	IP            string    `gorm:"column:ip" json:"ip"`
	DeviceID      *string   `gorm:"column:device_id" json:"device_id"`
	Success       bool      `gorm:"column:success" json:"success"`
	FailureReason *string   `gorm:"column:failure_reason" json:"failure_reason"`
	CreatedAt     time.Time `gorm:"column:created_at" json:"created_at"`
}

func (LoginAttempt) TableName() string { return "login_attempts" }

// RbacRole — role catalog; system roles free/admin are seeded idempotently.
type RbacRole struct {
	RoleID      string     `gorm:"column:role_id;primaryKey" json:"role_id"`
	Name        string     `gorm:"column:name" json:"name"`
	Description *string    `gorm:"column:description" json:"description"`
	IsSystem    *bool      `gorm:"column:is_system" json:"is_system"`
	CreatedAt   *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt   *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (RbacRole) TableName() string { return "rbac_role" }

// RbacUserRole — uid ↔ role association (is_active gate).
type RbacUserRole struct {
	ID        int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID       int64      `gorm:"column:uid" json:"uid"`
	RoleID    string     `gorm:"column:role_id" json:"role_id"`
	GrantedBy *int64     `gorm:"column:granted_by" json:"granted_by"`
	GrantedAt *time.Time `gorm:"column:granted_at" json:"granted_at"`
	ExpiresAt *time.Time `gorm:"column:expires_at" json:"expires_at"`
	IsActive  *bool      `gorm:"column:is_active" json:"is_active"`
	CreatedAt *time.Time `gorm:"column:created_at" json:"created_at"`
}

func (RbacUserRole) TableName() string { return "rbac_user_role" }
