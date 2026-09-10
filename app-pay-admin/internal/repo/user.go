// Package repo: admin console account store (payadmin_user table — the only
// table this service owns/migrates).
package repo

import (
	"errors"
	"fmt"
	"strings"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// Seeded default admin account, created on first start (empty table).
// CHANGE THE PASSWORD after first login (console account page).
const (
	DefaultAdminUser = "admin"
	DefaultAdminPass = "app-pay-admin"
)

// Console roles. admin = everything (grant + account management);
// viewer = read-only queries.
const (
	RoleAdmin  = "admin"
	RoleViewer = "viewer"
)

var (
	ErrUserNotFound = errors.New("user not found")
	ErrUserExists   = errors.New("username already exists")
	ErrLastAdmin    = errors.New("cannot delete the last admin")
)

func GetUserByUsername(username string) (*model.PayAdminUser, error) {
	var u model.PayAdminUser
	err := db.DB.Where("username = ?", username).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func GetUserByID(id int64) (*model.PayAdminUser, error) {
	var u model.PayAdminUser
	err := db.DB.First(&u, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func ListUsers() ([]model.PayAdminUser, error) {
	var us []model.PayAdminUser
	if err := db.DB.Order("username").Find(&us).Error; err != nil {
		return nil, err
	}
	return us, nil
}

func CountUsers() (int64, error) {
	var n int64
	err := db.DB.Model(&model.PayAdminUser{}).Count(&n).Error
	return n, err
}

func CountUsersByRole(role string) (int64, error) {
	var n int64
	err := db.DB.Model(&model.PayAdminUser{}).Where("role = ?", role).Count(&n).Error
	return n, err
}

// SetUserPassword re-hashes and stores a new password for a user.
func SetUserPassword(id int64, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	res := db.DB.Model(&model.PayAdminUser{}).Where("id = ?", id).Update("password_hash", string(hash))
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

func CreateUser(username, password, role string) (*model.PayAdminUser, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	u := &model.PayAdminUser{
		Username:     username,
		PasswordHash: string(hash),
		Role:         role,
	}
	if err := db.DB.Create(u).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) || containsUniqueViolation(err) {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return u, nil
}

// DeleteUser removes a user. The caller must ensure the target is not the
// authenticated caller and that at least one admin remains.
func DeleteUser(id int64) error {
	res := db.DB.Delete(&model.PayAdminUser{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

// EnsureDefaultAdmin seeds the default admin account on an empty table so the
// console is always login-gated from first boot.
func EnsureDefaultAdmin() error {
	n, err := CountUsers()
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err = CreateUser(DefaultAdminUser, DefaultAdminPass, RoleAdmin)
	return err
}

func containsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate entry") || strings.Contains(msg, "UNIQUE constraint failed")
}
