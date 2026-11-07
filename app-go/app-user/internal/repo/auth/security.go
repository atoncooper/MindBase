package repo

import (
	"time"

	"app-user/internal/model/auth"

	"gorm.io/gorm"
)

// PasswordHistoryRepo — recently used password hashes (reuse prevention).
type PasswordHistoryRepo struct{}

func NewPasswordHistoryRepo() *PasswordHistoryRepo { return &PasswordHistoryRepo{} }

// Insert records a previous password hash.
func (r *PasswordHistoryRepo) Insert(db *gorm.DB, uid int64, hash string) error {
	now := time.Now()
	return db.Create(&model.PasswordHistory{UID: uid, PasswordHash: hash, CreatedAt: &now}).Error
}

// ListRecent returns up to limit recent hashes, newest first.
func (r *PasswordHistoryRepo) ListRecent(db *gorm.DB, uid int64, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 5
	}
	var hashes []string
	err := db.Model(&model.PasswordHistory{}).
		Where("uid = ?", uid).
		Order("id DESC").
		Limit(limit).
		Pluck("password_hash", &hashes).Error
	return hashes, err
}

// SecurityEventRepo — append-only audit trail for credential/contact changes.
type SecurityEventRepo struct{}

func NewSecurityEventRepo() *SecurityEventRepo { return &SecurityEventRepo{} }

// Insert records one security event.
func (r *SecurityEventRepo) Insert(db *gorm.DB, ev *model.SecurityEvent) error {
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now()
	}
	return db.Create(ev).Error
}
