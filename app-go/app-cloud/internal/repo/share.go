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

// ListByFolder returns the owner's active shares for one folder (1.0.16).
func (r *ShareRepo) ListByFolder(db *gorm.DB, uid, folderID int64) ([]model.CloudShare, error) {
	var rows []model.CloudShare
	err := db.Where("uid = ? AND folder_id = ? AND is_revoked = 0", uid, folderID).
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

// GetOwned returns one of the owner's shares (any state) — for code reset.
func (r *ShareRepo) GetOwned(db *gorm.DB, id, uid int64) (*model.CloudShare, error) {
	var s model.CloudShare
	err := db.Where("id = ? AND uid = ?", id, uid).First(&s).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// GetByIDAnyState returns a share by primary key regardless of state — the
// cloud_refs read path re-validates revoked/banned/expiry itself so an
// invalidated share can be distinguished from a deleted ref row.
func (r *ShareRepo) GetByIDAnyState(db *gorm.DB, id int64) (*model.CloudShare, error) {
	var s model.CloudShare
	err := db.Where("id = ?", id).First(&s).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// UpdateExtractionCode rewrites the stored extraction code (owner-checked).
func (r *ShareRepo) UpdateExtractionCode(db *gorm.DB, id int64, stored string) error {
	res := db.Model(&model.CloudShare{}).
		Where("id = ?", id).
		Updates(map[string]any{"extraction_code": stored, "updated_at": time.Now()})
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

// TryIncrDownload atomically bumps download_count only while the share is
// still under its max_downloads cap — check and increment are one statement,
// so concurrent accesses cannot jointly overshoot the cap (the old
// resolve-check → presign → increment chain was check-then-act). Returns
// false when the cap is exhausted.
func (r *ShareRepo) TryIncrDownload(db *gorm.DB, id int64) (bool, error) {
	res := db.Model(&model.CloudShare{}).
		Where("id = ? AND (max_downloads IS NULL OR download_count < max_downloads)", id).
		UpdateColumn("download_count", gorm.Expr("download_count + 1"))
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// RevokeAllForFile revokes every active share of a file (called on delete —
// a trashed file must not stay shareable).
func (r *ShareRepo) RevokeAllForFile(db *gorm.DB, fileID int64) error {
	return db.Model(&model.CloudShare{}).
		Where("file_id = ? AND is_revoked = 0", fileID).
		Updates(map[string]any{"is_revoked": true, "updated_at": time.Now()}).Error
}

// RevokeAllForFolders revokes every active folder share whose folder_id hits
// the given subtree (plan/1.0.16 §4 — force folder delete drops its shares;
// the ids cover the whole subtree so shares pointing at a child folder die
// together with the top-level one). Soft (non-force) folder deletes stay
// restorable and therefore NOT revoked — a share of a trashed folder simply
// resolves uniformly as 404 until restore.
func (r *ShareRepo) RevokeAllForFolders(db *gorm.DB, folderIDs []int64) error {
	if len(folderIDs) == 0 {
		return nil
	}
	return db.Model(&model.CloudShare{}).
		Where("folder_id IN ? AND is_revoked = 0", folderIDs).
		Updates(map[string]any{"is_revoked": true, "updated_at": time.Now()}).Error
}
