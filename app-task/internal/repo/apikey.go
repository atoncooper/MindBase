package repo

// API key persistence: creation (hash only — plaintext never stored),
// lookup by hash for the auth middleware, listing/revocation for the
// console, and bootstrap seeding for env-provided service keys.

import (
	"errors"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

const (
	APIKeyStatusActive  = "active"
	APIKeyStatusRevoked = "revoked"
)

// CreateAPIKey inserts a new key row (caller supplies the SHA-256 hash, not
// the plaintext).
func CreateAPIKey(k *model.APIKey) error {
	return db.DB.Create(k).Error
}

// GetAPIKeyByHash resolves a presented credential to its row; nil, nil when
// unknown. Expired keys are reported as active=false by the caller via
// ExpiresAt — the row is still returned so the middleware can 401 precisely.
func GetAPIKeyByHash(keyHash string) (*model.APIKey, error) {
	var out model.APIKey
	err := db.DB.Where("key_hash = ?", keyHash).First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetAPIKeyByID fetches one key row by key_id; nil, nil when absent.
func GetAPIKeyByID(keyID string) (*model.APIKey, error) {
	var out model.APIKey
	err := db.DB.Where("key_id = ?", keyID).First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAPIKeys returns all keys, newest first (console management page).
func ListAPIKeys() ([]model.APIKey, error) {
	var out []model.APIKey
	err := db.DB.Order("id DESC").Find(&out).Error
	return out, err
}

// RevokeAPIKey flips status to revoked; returns false when the key is absent
// or already revoked (the console surfaces both as a no-op flash).
func RevokeAPIKey(keyID string) (bool, error) {
	res := db.DB.Model(&model.APIKey{}).
		Where("key_id = ? AND status = ?", keyID, APIKeyStatusActive).
		Update("status", APIKeyStatusRevoked)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// TouchAPIKeyUsed refreshes last_used_at, at most once per minute per key to
// avoid write amplification on hot paths.
func TouchAPIKeyUsed(keyID string, lastUsed *time.Time) {
	if lastUsed != nil && time.Since(*lastUsed) < time.Minute {
		return
	}
	now := time.Now()
	db.DB.Model(&model.APIKey{}).Where("key_id = ?", keyID).
		Update("last_used_at", &now)
}

// UpsertAPIKey seeds a bootstrap service key (env-provided). Rows are matched
// by NAME (bootstrap names are stable across restarts): an existing bootstrap
// row has its hash/prefix refreshed so rotating the env key takes effect on
// the next restart; rows created by console users with the same name are left
// untouched (names are globally unique, so a collision only means the user
// picked the reserved-looking name). Returns true when a row was created.
func UpsertAPIKey(k *model.APIKey) (bool, error) {
	var existing model.APIKey
	err := db.DB.Where("name = ?", k.Name).First(&existing).Error
	if err == nil {
		if existing.CreatedBy != "bootstrap" {
			return false, nil
		}
		return false, db.DB.Model(&model.APIKey{}).Where("id = ?", existing.ID).
			Updates(map[string]any{"key_hash": k.KeyHash, "key_prefix": k.KeyPrefix}).Error
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	return true, db.DB.Create(k).Error
}

// CountActiveAPIKeys returns the number of active keys (creation cap check).
func CountActiveAPIKeys() (int64, error) {
	var n int64
	err := db.DB.Model(&model.APIKey{}).Where("status = ?", APIKeyStatusActive).Count(&n).Error
	return n, err
}

// APIKeyNameExists reports whether ANY row already uses the name. Names are
// globally unique (DB unique index): revoked rows keep blocking reuse so a
// name always identifies exactly one key over its whole lifecycle.
func APIKeyNameExists(name string) (bool, error) {
	var n int64
	err := db.DB.Model(&model.APIKey{}).Where("name = ?", name).Count(&n).Error
	return n > 0, err
}

// UpdateAPIKeyScopesAndRate updates a key's scope CSV and rate cap (test and
// future console-edit support; revocation stays the primary lifecycle action).
func UpdateAPIKeyScopesAndRate(keyID, scopes string, ratePerMin int) error {
	return db.DB.Model(&model.APIKey{}).
		Where("key_id = ?", keyID).
		Updates(map[string]any{"scopes": scopes, "rate_per_min": ratePerMin}).Error
}
