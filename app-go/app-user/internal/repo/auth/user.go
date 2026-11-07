package repo

import (
	"sort"
	"strings"
	"time"

	"app-user/internal/model/auth"

	"gorm.io/gorm"
)

// UserRepo — users + user_profile access.
type UserRepo struct{}

func NewUserRepo() *UserRepo { return &UserRepo{} }

func (r *UserRepo) GetByUID(db *gorm.DB, uid int64) (*model.User, error) {
	var u model.User
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// InternalContact returns email/status for the internal M2M user lookup.
// It deliberately does not filter deleted_at (parity with the old service).
func (r *UserRepo) InternalContact(db *gorm.DB, uid int64) (*model.User, error) {
	var u model.User
	err := db.Select("uid", "email", "status", "deleted_at").Where("uid = ?", uid).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// GetByEmail / GetByEmailIncludingDeleted — lookups for login and register.
// Login must not reveal whether a soft-deleted account exists; register must
// refuse to reuse a deleted account's email (parity with the Python side).
func (r *UserRepo) GetByEmail(db *gorm.DB, email string) (*model.User, error) {
	return r.getBy(db, "email", email)
}

func (r *UserRepo) GetByPhone(db *gorm.DB, phone string) (*model.User, error) {
	return r.getBy(db, "phone", phone)
}

func (r *UserRepo) getBy(db *gorm.DB, col, val string) (*model.User, error) {
	var u model.User
	err := db.Where(col+" = ? AND deleted_at IS NULL", val).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// EmailExistsIncludingDeleted guards the unique index on register.
func (r *UserRepo) EmailExistsIncludingDeleted(db *gorm.DB, email string) (bool, error) {
	return r.exists(db, "email", email)
}

func (r *UserRepo) PhoneExistsIncludingDeleted(db *gorm.DB, phone string) (bool, error) {
	return r.exists(db, "phone", phone)
}

func (r *UserRepo) exists(db *gorm.DB, col, val string) (bool, error) {
	var n int64
	err := db.Model(&model.User{}).Where(col+" = ?", val).Count(&n).Error
	return n > 0, err
}

// Create inserts a user + empty profile in one transaction.
func (r *UserRepo) Create(db *gorm.DB, u *model.User, p *model.UserProfile) error {
	return db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		if u.CreatedAt == nil {
			u.CreatedAt = &now
		}
		if u.UpdatedAt == nil {
			u.UpdatedAt = &now
		}
		if err := tx.Create(u).Error; err != nil {
			return err
		}
		if p != nil {
			if p.CreatedAt == nil {
				p.CreatedAt = &now
			}
			if p.UpdatedAt == nil {
				p.UpdatedAt = &now
			}
			if err := tx.Create(p).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// UserInfoRow is the single-query projection used by /auth/me and the login
// response: account status + display profile + active roles in one round trip
// (replaces three sequential queries).
type UserInfoRow struct {
	UID       int64
	Status    *string
	CreatedAt *time.Time
	Nickname  *string
	Avatar    *string
	Roles     string
}

// GetUserInfo returns the user row joined with profile and aggregated roles.
// Soft-deleted users are reported as not found.
func (r *UserRepo) GetUserInfo(db *gorm.DB, uid int64) (*UserInfoRow, error) {
	var row UserInfoRow
	err := db.Table("users AS u").
		Select("u.uid, u.status, u.created_at, p.nickname, p.avatar, "+
			"COALESCE((SELECT GROUP_CONCAT(r.role_id ORDER BY r.role_id) FROM rbac_user_role r "+
			"WHERE r.uid = u.uid AND r.is_active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?)), '') AS roles",
			time.Now()).
		Joins("LEFT JOIN user_profile p ON p.uid = u.uid").
		Where("u.uid = ? AND u.deleted_at IS NULL", uid).
		Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.UID == 0 {
		return nil, nil
	}
	return &row, nil
}

// UserStatusRow is the account gate projection for the forward-auth hot path.
type UserStatusRow struct {
	Status    *string
	DeletedAt *time.Time
}

// GetStatus loads status/deleted_at for the disabled-account check (cached by
// the authz cache; this query runs at most once per TTL per user).
func (r *UserRepo) GetStatus(db *gorm.DB, uid int64) (status string, deleted bool, err error) {
	var row UserStatusRow
	err = db.Table("users").Select("status", "deleted_at").Where("uid = ?", uid).Take(&row).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return "", true, nil
		}
		return "", false, err
	}
	if row.Status != nil {
		status = *row.Status
	}
	return status, row.DeletedAt != nil, nil
}

// UpdateProfileFields patches mutable profile columns on user_profile
// (upserting the row when absent) and refreshes users.updated_at.
func (r *UserRepo) UpdateProfileFields(db *gorm.DB, uid int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	now := time.Now()
	fields["updated_at"] = now

	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	cols := []string{"uid"}
	vals := []any{uid}
	marks := []string{"?"}
	sets := make([]string, 0, len(keys))
	for _, k := range keys {
		cols = append(cols, k)
		vals = append(vals, fields[k])
		marks = append(marks, "?")
		sets = append(sets, k+"=VALUES("+k+")")
	}
	// created_at only participates in the INSERT branch.
	cols = append(cols, "created_at")
	vals = append(vals, now)
	marks = append(marks, "?")

	sql := "INSERT INTO user_profile (" + strings.Join(cols, ", ") + ") VALUES (" +
		strings.Join(marks, ", ") + ") ON DUPLICATE KEY UPDATE " + strings.Join(sets, ", ")
	return db.Exec(sql, vals...).Error
}

func (r *UserRepo) GetProfile(db *gorm.DB, uid int64) (*model.UserProfile, error) {
	var p model.UserProfile
	err := db.Where("uid = ?", uid).First(&p).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// SetUserFields patches columns on users (password_hash, verified flags,
// email/phone binding, status).
func (r *UserRepo) SetUserFields(db *gorm.DB, uid int64, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return db.Model(&model.User{}).Where("uid = ?", uid).Updates(fields).Error
}
