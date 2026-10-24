// Package repo: admin console accounts, DB sessions, admin-plane queries and
// the single controlled write onto the shared schema (cloud_shares moderation
// columns). Everything here is the data-access layer; business rules live in
// internal/service.
package repo

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// Console roles. admin = read everything + moderation writes; viewer = read
// only (ban / unban / approve are admin-only; /api/me/password is open to any
// logged-in account).
const (
	RoleAdmin  = "admin"
	RoleViewer = "viewer"
)

var (
	ErrUserNotFound   = errors.New("admin user not found")
	ErrUserExists     = errors.New("username already exists")
	ErrWeakPassword   = errors.New("new password must be at least 8 characters")
	ErrWrongOldPass   = errors.New("old password incorrect")
	ErrSessionExpired = errors.New("session expired or unknown")
)

// ── accounts ─────────────────────────────────────────────────────────────

func GetUserByUsername(username string) (*model.AdminUser, error) {
	var u model.AdminUser
	err := db.DB.Where("username = ?", username).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func GetUserByID(id int64) (*model.AdminUser, error) {
	var u model.AdminUser
	err := db.DB.First(&u, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CountAdminUsers reports the number of console accounts (seed guard).
func CountAdminUsers() (int64, error) {
	var n int64
	err := db.DB.Model(&model.AdminUser{}).Count(&n).Error
	return n, err
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// EnsureSeedAdmin inserts the configured seed account only when that username
// is missing (never overwrites an existing row — same semantics as
// app-pay-admin). must_change_password=1 forces a first-login password change
// via POST /api/me/password.
func EnsureSeedAdmin(username, password string) error {
	existing, err := GetUserByUsername(username)
	if err != nil {
		return err
	}
	if existing != nil {
		return nil
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	u := &model.AdminUser{
		Username:           username,
		PasswordHash:       hash,
		Role:               RoleAdmin,
		MustChangePassword: true,
	}
	return db.DB.Create(u).Error
}

// SetUserPassword re-hashes and stores a new password, optionally clearing
// must_change_password (self-service change via /api/me/password).
func SetUserPassword(id int64, password string, clearMustChange bool) error {
	if len(password) < 8 {
		return ErrWeakPassword
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	updates := map[string]any{
		"password_hash": hash,
		"updated_at":    time.Now(),
	}
	if clearMustChange {
		updates["must_change_password"] = false
	}
	res := db.DB.Model(&model.AdminUser{}).Where("id = ?", id).Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

// TouchLogin stamps last_login_at after a successful login.
func TouchLogin(id int64) error {
	return db.DB.Model(&model.AdminUser{}).Where("id = ?", id).
		Update("last_login_at", time.Now()).Error
}

func containsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate entry") || strings.Contains(msg, "UNIQUE constraint failed")
}
