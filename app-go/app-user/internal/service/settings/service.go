// Package settings holds the settings-domain business logic (preferences).
// SQL lives in internal/repo/settings; the HTTP layer only parses input and
// calls this service.
package settings

import (
	"context"

	pert "app-user/internal/repo/settings"

	"gorm.io/gorm"
)

// Service is the settings-domain business facade.
type Service struct{ db *gorm.DB }

// New builds the settings service on the shared MySQL connection.
func New(db *gorm.DB) *Service { return &Service{db: db} }

// Ping is the readiness probe. Nil DB = not configured (ok for offline tests).
func (s *Service) Ping(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	return pert.Ping(ctx, s.db)
}

// GetAllPreferences returns {key: raw JSON value}.
func (s *Service) GetAllPreferences(ctx context.Context, uid int64) (map[string]string, error) {
	if s == nil || s.db == nil {
		return map[string]string{}, nil
	}
	return pert.GetAllPreferences(ctx, s.db, uid)
}

// UpsertPreference writes one preference key.
func (s *Service) UpsertPreference(ctx context.Context, uid int64, key, value string) error {
	if s == nil || s.db == nil {
		return nil
	}
	return pert.UpsertPreference(ctx, s.db, uid, key, value)
}

// UpsertPreferences writes a batch of preference keys in one statement.
func (s *Service) UpsertPreferences(ctx context.Context, uid int64, prefs map[string]string) error {
	if s == nil || s.db == nil {
		return nil
	}
	return pert.UpsertPreferences(ctx, s.db, uid, prefs)
}
