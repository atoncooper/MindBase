package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// ShareRepo — cloud_shares access.
type ShareRepo struct{}

func NewShareRepo() *ShareRepo { return &ShareRepo{} }

// Create inserts a share link row.
func (r *ShareRepo) Create(db *gorm.DB, s *model.CloudShare) error {
	now := time.Now()
	if s.CreatedAt == nil {
		s.CreatedAt = &now
	}
	if s.UpdatedAt == nil {
		s.UpdatedAt = &now
	}
	return db.Create(s).Error
}

// GetByToken returns the share row for a token (any state — validity is
// judged by the service layer so invalid shares read uniformly).
func (r *ShareRepo) GetByToken(db *gorm.DB, token string) (*model.CloudShare, error) {
	var s model.CloudShare
	err := db.Where("share_token = ?", token).First(&s).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// ListByFile returns the owner's active shares for one file.
func (r *ShareRepo) ListByFile(db *gorm.DB, uid, fileID int64) ([]model.CloudShare, error) {
	var rows []model.CloudShare
	err := db.Where("uid = ? AND file_id = ? AND is_revoked = 0", uid, fileID).
		Order("id DESC").Find(&rows).Error
	return rows, err
}

// Revoke marks a share revoked (owner-checked).
func (r *ShareRepo) Revoke(db *gorm.DB, id, uid int64) error {
	res := db.Model(&model.CloudShare{}).
		Where("id = ? AND uid = ?", id, uid).
		Updates(map[string]any{"is_revoked": true, "updated_at": time.Now()})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// IncrView / IncrDownload — atomic counters (share access analytics).
func (r *ShareRepo) IncrView(db *gorm.DB, id int64) error {
	return db.Model(&model.CloudShare{}).Where("id = ?", id).
		UpdateColumn("view_count", gorm.Expr("view_count + 1")).Error
}

func (r *ShareRepo) IncrDownload(db *gorm.DB, id int64) error {
	return db.Model(&model.CloudShare{}).Where("id = ?", id).
		UpdateColumn("download_count", gorm.Expr("download_count + 1")).Error
}

// RevokeAllForFile revokes every active share of a file (called on delete —
// a trashed file must not stay shareable).
func (r *ShareRepo) RevokeAllForFile(db *gorm.DB, fileID int64) error {
	return db.Model(&model.CloudShare{}).
		Where("file_id = ? AND is_revoked = 0", fileID).
		Updates(map[string]any{"is_revoked": true, "updated_at": time.Now()}).Error
}
