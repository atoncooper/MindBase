package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// OAuthRepo — user_oauth access (bilibili/wechat bindings).
type OAuthRepo struct{}

func NewOAuthRepo() *OAuthRepo { return &OAuthRepo{} }

// GetByProvider returns the active (non-deleted) binding for a platform uid.
func (r *OAuthRepo) GetByProvider(db *gorm.DB, provider, providerUID string) (*model.UserOAuth, error) {
	var o model.UserOAuth
	err := db.Where(
		"provider = ? AND provider_uid = ? AND deleted_at IS NULL", provider, providerUID,
	).First(&o).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &o, nil
}

// GetByUIDProvider returns the active binding of a user for one provider.
func (r *OAuthRepo) GetByUIDProvider(db *gorm.DB, uid int64, provider string) (*model.UserOAuth, error) {
	var o model.UserOAuth
	err := db.Where(
		"uid = ? AND provider = ? AND deleted_at IS NULL", uid, provider,
	).First(&o).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &o, nil
}

// Create inserts a binding row (access_token already AES-encrypted by the
// service layer).
func (r *OAuthRepo) Create(db *gorm.DB, o *model.UserOAuth) error {
	now := time.Now()
	if o.CreatedAt == nil {
		o.CreatedAt = &now
	}
	if o.UpdatedAt == nil {
		o.UpdatedAt = &now
	}
	return db.Create(o).Error
}

// UpdateTokens refreshes the encrypted tokens of an existing binding.
func (r *OAuthRepo) UpdateTokens(db *gorm.DB, id int64, accessToken, refreshToken *string) error {
	fields := map[string]any{"updated_at": time.Now()}
	if accessToken != nil {
		fields["access_token"] = *accessToken
	}
	if refreshToken != nil {
		fields["refresh_token"] = *refreshToken
	}
	return db.Model(&model.UserOAuth{}).Where("id = ?", id).Updates(fields).Error
}

// ListByUID returns all active bindings of a user (security overview).
func (r *OAuthRepo) ListByUID(db *gorm.DB, uid int64) ([]model.UserOAuth, error) {
	var rows []model.UserOAuth
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).Find(&rows).Error
	return rows, err
}

// SoftDelete unbinds (deleted_at set, row retained).
func (r *OAuthRepo) SoftDelete(db *gorm.DB, id int64) error {
	now := time.Now()
	return db.Model(&model.UserOAuth{}).Where("id = ?", id).Update("deleted_at", now).Error
}
