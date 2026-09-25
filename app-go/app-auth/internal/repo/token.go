// Package repo is the data-access layer for the auth tables. Pure GORM
// queries — business rules live in internal/service.
package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// TokenRepo — user_tokens access.
type TokenRepo struct{}

func NewTokenRepo() *TokenRepo { return &TokenRepo{} }

// Create persists a new session token row.
func (r *TokenRepo) Create(db *gorm.DB, t *model.UserToken) error {
	return db.Create(t).Error
}

// FindValid returns the row for a still-valid token (not revoked, not soft
// deleted, not expired), or nil.
func (r *TokenRepo) FindValid(db *gorm.DB, sessionToken string) (*model.UserToken, error) {
	var t model.UserToken
	now := time.Now()
	err := db.Where(
		"session_token = ? AND (is_revoked IS NULL OR is_revoked = 0) AND deleted_at IS NULL "+
			"AND (expires_at IS NULL OR expires_at > ?)",
		sessionToken, now,
	).First(&t).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &t, nil
}

// BumpActivity refreshes last_active_at (throttled to once per minute by the
// service layer to avoid a write per request).
func (r *TokenRepo) BumpActivity(db *gorm.DB, sessionToken string) error {
	return db.Model(&model.UserToken{}).
		Where("session_token = ?", sessionToken).
		Update("last_active_at", time.Now()).Error
}

// Revoke marks a token revoked + soft deleted.
func (r *TokenRepo) Revoke(db *gorm.DB, sessionToken string) error {
	now := time.Now()
	return db.Model(&model.UserToken{}).
		Where("session_token = ?", sessionToken).
		Updates(map[string]any{"is_revoked": true, "deleted_at": now}).Error
}

// RevokeAllForUser revokes every active token of a user.
func (r *TokenRepo) RevokeAllForUser(db *gorm.DB, uid int64) error {
	now := time.Now()
	return db.Model(&model.UserToken{}).
		Where("uid = ? AND (is_revoked IS NULL OR is_revoked = 0) AND deleted_at IS NULL", uid).
		Updates(map[string]any{"is_revoked": true, "deleted_at": now}).Error
}

// ListActive returns the user's active tokens, newest first.
func (r *TokenRepo) ListActive(db *gorm.DB, uid int64) ([]model.UserToken, error) {
	var rows []model.UserToken
	now := time.Now()
	err := db.Where(
		"uid = ? AND (is_revoked IS NULL OR is_revoked = 0) AND deleted_at IS NULL "+
			"AND (expires_at IS NULL OR expires_at > ?)",
		uid, now,
	).Order("created_at DESC").Find(&rows).Error
	return rows, err
}
