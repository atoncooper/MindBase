// Package repo: webui admin-console account store (webui_user table).
package repo

import (
	"errors"
	"fmt"
	"strings"

	"app-task/internal/db"
	"app-task/internal/model"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// Seeded default admin account, created on first start (empty table).
const (
	DefaultAdminUser = "admin"
	DefaultAdminPass = "app-task-admin"
)

var (
	ErrUserNotFound   = errors.New("user not found")
	ErrUserExists     = errors.New("username already exists")
	ErrSecretExists   = errors.New("secret name already exists")
	ErrSecretNotFound = errors.New("secret not found")
	ErrLastAdmin      = errors.New("cannot delete the last admin")
)

func GetUserByUsername(username string) (*model.WebUIUser, error) {
	var u model.WebUIUser
	err := db.DB.Where("username = ?", username).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func GetUserByID(id int64) (*model.WebUIUser, error) {
	var u model.WebUIUser
	err := db.DB.First(&u, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func ListUsers() ([]model.WebUIUser, error) {
	var us []model.WebUIUser
	if err := db.DB.Order("username").Find(&us).Error; err != nil {
		return nil, err
	}
	return us, nil
}

func CountUsers() (int64, error) {
	var n int64
	err := db.DB.Model(&model.WebUIUser{}).Count(&n).Error
	return n, err
}

func CountUsersByRole(role string) (int64, error) {
	var n int64
	err := db.DB.Model(&model.WebUIUser{}).Where("role = ?", role).Count(&n).Error
	return n, err
}

// SetUserPassword re-hashes and stores a new password for a user.
func SetUserPassword(id int64, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	res := db.DB.Model(&model.WebUIUser{}).Where("id = ?", id).Update("password_hash", string(hash))
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

func CreateUser(username, password, role string) (*model.WebUIUser, error) {
	return createUser(username, password, role, "")
}

// CreateUserWithID inserts a user with an explicit UUID (startup backfill).
func CreateUserWithID(userID, username, password, role string) (*model.WebUIUser, error) {
	return createUser(username, password, role, userID)
}

func createUser(username, password, role, userID string) (*model.WebUIUser, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	if userID == "" {
		userID = uuid.NewString()
	}
	u := &model.WebUIUser{
		UserID:       userID,
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
	res := db.DB.Delete(&model.WebUIUser{}, id)
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
	_, err = CreateUser(DefaultAdminUser, DefaultAdminPass, "admin")
	return err
}

func containsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Duplicate entry") || strings.Contains(msg, "UNIQUE constraint failed")
}

// GetUserByUserID fetches a user by its UUID identifier; nil, nil when absent.
func GetUserByUserID(userID string) (*model.WebUIUser, error) {
	var u model.WebUIUser
	err := db.DB.Where("user_id = ?", userID).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// EnsureUserIDs backfills UUID identifiers for user rows created before the
// user_id column existed (idempotent; runs once at startup after migrate).
func EnsureUserIDs() error {
	var rows []model.WebUIUser
	if err := db.DB.Where("user_id IS NULL OR user_id = ''").Find(&rows).Error; err != nil {
		return err
	}
	for _, u := range rows {
		if err := db.DB.Model(&model.WebUIUser{}).Where("id = ?", u.ID).
			Update("user_id", uuid.NewString()).Error; err != nil {
			return err
		}
	}
	return nil
}
