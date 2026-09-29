package repo

// Secret persistence for the central credential store. Values are stored
// AES-256-GCM encrypted (internal/security); plaintext never reaches this
// package or the database.

import (
	"errors"

	"app-task/internal/db"
	"app-task/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// CreateSecret inserts a new secret; duplicate name maps to ErrSecretExists.
func CreateSecret(s *model.Secret) error {
	err := db.DB.Create(s).Error
	if err != nil && containsUniqueViolation(err) {
		return ErrSecretExists
	}
	return err
}

// UpdateSecret overwrites description and (optionally) the encrypted value of
// an existing secret, addressed by its UUID identifier (not the name — names
// are the script-facing handle and may never change). Empty valueEnc keeps
// the stored value.
func UpdateSecret(secretID, description, valueEnc, updatedBy string) error {
	updates := map[string]any{"description": description, "updated_by": updatedBy}
	if valueEnc != "" {
		updates["value_enc"] = valueEnc
	}
	res := db.DB.Model(&model.Secret{}).Where("secret_id = ?", secretID).Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrSecretNotFound
	}
	return nil
}

// GetSecretByName fetches one secret row (value still encrypted); nil, nil
// when absent.
func GetSecretByName(name string) (*model.Secret, error) {
	var out model.Secret
	err := db.DB.Where("name = ?", name).First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListSecrets returns all secrets (metadata only — ValueEnc stays populated
// but callers must never render it).
func ListSecrets() ([]model.Secret, error) {
	var out []model.Secret
	err := db.DB.Order("name").Find(&out).Error
	return out, err
}

// DeleteSecret removes a secret by name; false when absent.
func DeleteSecret(name string) (bool, error) {
	res := db.DB.Where("name = ?", name).Delete(&model.Secret{})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// CountSecrets returns the number of stored secrets (creation cap check).
func CountSecrets() (int64, error) {
	var n int64
	err := db.DB.Model(&model.Secret{}).Count(&n).Error
	return n, err
}

// DeleteScriptByID removes a script and its versions by script_id; false when
// absent (shared-DB test hygiene helper).
func DeleteScriptByID(scriptID string) (bool, error) {
	res := db.DB.Where("script_id = ?", scriptID).Delete(&model.Script{})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// GetSecretBySecretID fetches one secret row by its UUID identifier; nil, nil
// when absent.
func GetSecretBySecretID(secretID string) (*model.Secret, error) {
	var out model.Secret
	err := db.DB.Where("secret_id = ?", secretID).First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// EnsureSecretIDs backfills UUID identifiers for rows created before the
// secret_id column existed (idempotent; runs once at startup).
func EnsureSecretIDs() error {
	var rows []model.Secret
	if err := db.DB.Where("secret_id IS NULL OR secret_id = ''").Find(&rows).Error; err != nil {
		return err
	}
	for _, s := range rows {
		if err := db.DB.Model(&model.Secret{}).Where("id = ?", s.ID).
			Update("secret_id", uuid.NewString()).Error; err != nil {
			return err
		}
	}
	return nil
}
