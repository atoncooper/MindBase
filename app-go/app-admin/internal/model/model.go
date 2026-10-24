// Package model maps app-admin's OWN tables (admin_user / admin_session /
// admin_audit - the only three this service migrates, see internal/db) plus
// read-only row mappings of the shared bilirag tables it moderates.
//
// RED LINES (the guard test pins the Migrate side):
//   - cloud_shares / cloud_files / cloud_folders / users / rbac_role /
//     rbac_user_role / user_profile are owned by app-cloud / app-auth -
//     plain row mappings here, NEVER migrated, never ALTERed. The only
//     write into shared tables is the four moderation columns on
//     cloud_shares via UPDATE (plan/1.0.16 section 3.1 / 5).
//   - No MinIO / object storage dependency at all: only name / size
//     metadata ever leaves the DB (admin must not see user file contents).
package model

import "time"

// ` own tables (migrated by db.Migrate - CREATE TABLE IF NOT EXISTS) `

// AdminUser is the console account store (bcrypt password hash). Seeded with
// admin / app-admin (env-overridable), must_change_password forced to 1 so the
// first login must POST /api/me/password.
type AdminUser struct {
	ID                 int64      `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	Username           string     `gorm:"column:username;type:varchar(64);not null;uniqueIndex"`
	PasswordHash       string     `gorm:"column:password_hash;type:varchar(100);not null" json:"-"`
	Role               string     `gorm:"column:role;type:varchar(20);not null;default:viewer"` // admin / viewer
	MustChangePassword bool       `gorm:"column:must_change_password;not null;default:true"`
	LastLoginAt        *time.Time `gorm:"column:last_login_at"`
	CreatedAt          *time.Time `gorm:"column:created_at"`
	UpdatedAt          *time.Time `gorm:"column:updated_at"`
}

func (AdminUser) TableName() string { return "admin_user" }

// AdminSession is the DB-backed login session (HttpOnly cookie admin_session,
// sliding 12h expiry - touched on every authenticated request).
type AdminSession struct {
	SessionToken string     `gorm:"column:session_token;type:varchar(128);primaryKey"`
	AdminUserID  int64      `gorm:"column:admin_user_id;not null;index"`
	ExpiresAt    time.Time  `gorm:"column:expires_at;not null"`
	IP           *string    `gorm:"column:ip;type:varchar(64)"`
	UserAgent    *string    `gorm:"column:user_agent;type:varchar(500)"`
	CreatedAt    *time.Time `gorm:"column:created_at"`
}

func (AdminSession) TableName() string { return "admin_session" }

// AdminAudit is the operation ledger for every moderation / auth action
// (ban / unban / approve / login / logout / change_password).
type AdminAudit struct {
	ID         int64      `gorm:"column:id;primaryKey;autoIncrement"`
	AdminName  string     `gorm:"column:admin_name;type:varchar(64);not null"`
	Action     string     `gorm:"column:action;type:varchar(32);not null"`
	TargetType *string    `gorm:"column:target_type;type:varchar(32)"`
	TargetID   *string    `gorm:"column:target_id;type:varchar(64)"`
	Detail     *string    `gorm:"column:detail;type:varchar(500)"`
	CreatedAt  *time.Time `gorm:"column:created_at"`
}

func (AdminAudit) TableName() string { return "admin_audit" }

// ` shared bilirag tables: read-only row mappings (never migrated) `

// User maps users (identity authority = app-auth). password_hash is mapped
// but always excluded from any JSON payload.
type User struct {
	UID          int64      `gorm:"column:uid;primaryKey"`
	Status       *string    `gorm:"column:status;type:varchar(20)"`
	CreatedAt    *time.Time `gorm:"column:created_at"`
	UpdatedAt    *time.Time `gorm:"column:updated_at"`
	DeletedAt    *time.Time `gorm:"column:deleted_at"`
	Email        *string    `gorm:"column:email"`
	Phone        *string    `gorm:"column:phone"`
	PasswordHash *string    `gorm:"column:password_hash" json:"-"`
}

func (User) TableName() string { return "users" }

// UserProfile maps user_profile (nickname used for admin display).
type UserProfile struct {
	UID      int64   `gorm:"column:uid;primaryKey"`
	Nickname *string `gorm:"column:nickname"`
}

func (UserProfile) TableName() string { return "user_profile" }

// RbacUserRole maps rbac_user_role. NULL is_active counts as active, matching
// app-auth semantics (joins here mirror that).
type RbacUserRole struct {
	ID        int64      `gorm:"column:id;primaryKey"`
	UID       int64      `gorm:"column:uid;not null"`
	RoleID    string     `gorm:"column:role_id;type:varchar(64);not null"`
	GrantedBy *int64     `gorm:"column:granted_by"`
	GrantedAt *time.Time `gorm:"column:granted_at"`
	ExpiresAt *time.Time `gorm:"column:expires_at"`
	IsActive  *bool      `gorm:"column:is_active"`
	CreatedAt *time.Time `gorm:"column:created_at"`
}

func (RbacUserRole) TableName() string { return "rbac_user_role" }

// RbacRole maps rbac_role (granted permission names for admin display).
type RbacRole struct {
	RoleID      string     `gorm:"column:role_id;primaryKey"`
	Name        string     `gorm:"column:name;type:varchar(50);not null"`
	Description *string    `gorm:"column:description"`
	IsSystem    *bool      `gorm:"column:is_system"`
	CreatedAt   *time.Time `gorm:"column:created_at"`
	UpdatedAt   *time.Time `gorm:"column:updated_at"`
}

func (RbacRole) TableName() string { return "rbac_role" }

// CloudShare maps cloud_shares (owner = app-cloud, which also owns the
// target_type / folder_id / legal_ack / moderation_* columns from plan 1.0.16
// section 3.1). app-admin only ever UPDATEs the four moderation columns.
type CloudShare struct {
	ID               int64      `gorm:"column:id;primaryKey"`
	ShareToken       string     `gorm:"column:share_token"`
	UID              int64      `gorm:"column:uid;not null"`
	FileID           int64      `gorm:"column:file_id;not null"`
	TargetType       *string    `gorm:"column:target_type;type:varchar(10)"` // 'file' | 'folder' (NULL = legacy row -> file)
	FolderID         *int64     `gorm:"column:folder_id"`
	LegalAck         *bool      `gorm:"column:legal_ack"`
	ExtractionCode   *string    `gorm:"column:extraction_code;type:varchar(64)"`
	ExpiresAt        *time.Time `gorm:"column:expires_at"`
	MaxDownloads     *int       `gorm:"column:max_downloads"`
	ViewCount        int        `gorm:"column:view_count;not null;default:0"`
	DownloadCount    int        `gorm:"column:download_count;not null;default:0"`
	IsRevoked        bool       `gorm:"column:is_revoked;not null;default:false"`
	ModerationStatus string     `gorm:"column:moderation_status;type:varchar(10);not null;default:'active'"`
	ModerationReason *string    `gorm:"column:moderation_reason;type:varchar(500)"`
	ModerationTime   *time.Time `gorm:"column:moderation_time"`
	ModerationBy     *string    `gorm:"column:moderation_by;type:varchar(64)"`
	CreatedAt        *time.Time `gorm:"column:created_at"`
	UpdatedAt        *time.Time `gorm:"column:updated_at"`
}

func (CloudShare) TableName() string { return "cloud_shares" }

// CloudFile maps cloud_files - metadata only (name/size/mime). bucket /
// object_key are deliberately NOT mapped: the admin plane has no MinIO
// access and no reason to know where an object lives.
type CloudFile struct {
	ID           int64      `gorm:"column:id;primaryKey"`
	UploadUUID   string     `gorm:"column:upload_uuid;type:varchar(64);not null"`
	UID          int64      `gorm:"column:uid;not null"`
	FolderID     *int64     `gorm:"column:folder_id"`
	OriginalName string     `gorm:"column:original_name;type:varchar(500);not null"`
	FileSize     int64      `gorm:"column:file_size;not null"`
	MimeType     string     `gorm:"column:mime_type;type:varchar(128);not null"`
	CreatedAt    *time.Time `gorm:"column:created_at"`
	UpdatedAt    *time.Time `gorm:"column:updated_at"`
	DeletedAt    *time.Time `gorm:"column:deleted_at"`
}

func (CloudFile) TableName() string { return "cloud_files" }

// CloudFolder maps cloud_folders.
type CloudFolder struct {
	ID        int64      `gorm:"column:id;primaryKey"`
	UID       int64      `gorm:"column:uid;not null"`
	ParentID  *int64     `gorm:"column:parent_id"`
	Name      string     `gorm:"column:name;type:varchar(200);not null"`
	CreatedAt *time.Time `gorm:"column:created_at"`
	UpdatedAt *time.Time `gorm:"column:updated_at"`
	DeletedAt *time.Time `gorm:"column:deleted_at"`
}

func (CloudFolder) TableName() string { return "cloud_folders" }
