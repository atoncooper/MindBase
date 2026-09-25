package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// LoginAttemptRepo — login_attempts audit/failure-count access.
type LoginAttemptRepo struct{}

func NewLoginAttemptRepo() *LoginAttemptRepo { return &LoginAttemptRepo{} }

// Insert records one login attempt (success or failure).
func (r *LoginAttemptRepo) Insert(db *gorm.DB, la *model.LoginAttempt) error {
	if la.CreatedAt.IsZero() {
		la.CreatedAt = time.Now()
	}
	return db.Create(la).Error
}

// CountRecentFailures counts failed attempts for one dimension since `since`.
// Used for the DB-backed login cooldown (complements the Redis throttle).
func (r *LoginAttemptRepo) CountRecentFailures(db *gorm.DB, col string, val string, since time.Time) (int64, error) {
	var n int64
	if err := db.Model(&model.LoginAttempt{}).
		Where(col+" = ? AND success = 0 AND created_at >= ?", val, since).
		Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}
