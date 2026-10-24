// DB-backed login sessions (admin_session table): HttpOnly cookie
// admin_session, sliding expiry — every authenticated request pushes
// expires_at forward, so an active admin never gets logged out mid-work while
// an idle session dies after the TTL.
package repo

import (
	"errors"
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"

	"gorm.io/gorm"
)

// SessionBundle is a resolved session: the row + the owning account.
type SessionBundle struct {
	Session model.AdminSession
	User    model.AdminUser
}

// CreateSession persists a fresh login session.
func CreateSession(token string, userID int64, ip, userAgent string, expires time.Time) error {
	s := &model.AdminSession{
		SessionToken: token,
		AdminUserID:  userID,
		ExpiresAt:    expires,
		IP:           strPtr(ip),
		UserAgent:    strPtr(truncate(userAgent, 500)),
	}
	return db.DB.Create(s).Error
}

// GetSession resolves a token to a still-valid session + user. Returns
// (nil, nil) when the token is unknown/expired.
func GetSession(token string) (*SessionBundle, error) {
	var s model.AdminSession
	err := db.DB.Where("session_token = ?", token).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if time.Now().After(s.ExpiresAt) {
		// Expired row survives until the next login purge; treat it as absent.
		return nil, nil
	}
	var u model.AdminUser
	if err := db.DB.First(&u, s.AdminUserID).Error; err != nil {
		return nil, err
	}
	return &SessionBundle{Session: s, User: u}, nil
}

// TouchSession slides the expiry forward (called on every authenticated
// request). Cheap single-row UPDATE keyed on the primary key token.
func TouchSession(token string, expires time.Time) error {
	return db.DB.Model(&model.AdminSession{}).Where("session_token = ?", token).
		Update("expires_at", expires).Error
}

// DeleteSession removes exactly one session (logout).
func DeleteSession(token string) error {
	return db.DB.Where("session_token = ?", token).Delete(&model.AdminSession{}).Error
}

// PurgeExpiredSessions drops stale rows (called opportunistically on login so
// the table stays small without a background sweeper).
func PurgeExpiredSessions() error {
	return db.DB.Where("expires_at < ?", time.Now()).Delete(&model.AdminSession{}).Error
}

// DeleteUserSessions removes every session of an account.
func DeleteUserSessions(userID int64) error {
	return db.DB.Where("admin_user_id = ?", userID).Delete(&model.AdminSession{}).Error
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
