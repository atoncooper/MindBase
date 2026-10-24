package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// RefRepo — cloud_refs access (plan/1.0.16 §3.2). Refs are reference rows:
// they never copy objects and never touch quota. Read paths re-validate the
// source side and flip dead refs via MarkDead.
type RefRepo struct{}

func NewRefRepo() *RefRepo { return &RefRepo{} }

// Create inserts one ref row (timestamps filled when absent).
func (r *RefRepo) Create(db *gorm.DB, ref *model.CloudRef) error {
	now := time.Now()
	if ref.CreatedAt == nil {
		ref.CreatedAt = &now
	}
	if ref.UpdatedAt == nil {
		ref.UpdatedAt = &now
	}
	if ref.Status == "" {
		ref.Status = "alive"
	}
	return db.Create(ref).Error
}

// CreateBatch inserts refs in one multi-row statement (bounded batch — the
// caller caps the whole save at 2000 rows).
func (r *RefRepo) CreateBatch(db *gorm.DB, rows []model.CloudRef) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now()
	for i := range rows {
		if rows[i].CreatedAt == nil {
			rows[i].CreatedAt = &now
		}
		if rows[i].UpdatedAt == nil {
			rows[i].UpdatedAt = &now
		}
		if rows[i].Status == "" {
			rows[i].Status = "alive"
		}
	}
	return db.CreateInBatches(rows, 100).Error
}

// FindAliveExisting returns the caller's ALIVE refs for one share — the
// idempotency key for SaveShare (same uid+share_id+source_file_id → skip).
func (r *RefRepo) FindAliveExisting(db *gorm.DB, uid, shareID int64) ([]model.CloudRef, error) {
	var rows []model.CloudRef
	err := db.Where("uid = ? AND share_id = ? AND status = 'alive' AND deleted_at IS NULL", uid, shareID).
		Order("id").Find(&rows).Error
	return rows, err
}

// ListByFolder returns the saver's alive refs under one folder (nil = root),
// newest first. Bounded to keep a poisoned row-set from exploding memory.
func (r *RefRepo) ListByFolder(db *gorm.DB, uid int64, folderID *int64, limit int) ([]model.CloudRef, error) {
	q := db.Model(&model.CloudRef{}).
		Where("uid = ? AND status = 'alive' AND deleted_at IS NULL", uid)
	if folderID != nil {
		q = q.Where("folder_id = ?", *folderID)
	} else {
		q = q.Where("folder_id IS NULL")
	}
	var rows []model.CloudRef
	err := q.Order("created_at DESC, id DESC").Limit(limit).Find(&rows).Error
	return rows, err
}

// CountByFolder — alive refs count under one folder (nil = root).
func (r *RefRepo) CountByFolder(db *gorm.DB, uid int64, folderID *int64) (int64, error) {
	q := db.Model(&model.CloudRef{}).
		Where("uid = ? AND status = 'alive' AND deleted_at IS NULL", uid)
	if folderID != nil {
		q = q.Where("folder_id = ?", *folderID)
	} else {
		q = q.Where("folder_id IS NULL")
	}
	var n int64
	err := q.Count(&n).Error
	return n, err
}

// GetOwned returns one alive ref of the caller (soft-deleted rows read as
// absent — deleting a ref twice must 404 the second time).
func (r *RefRepo) GetOwned(db *gorm.DB, id, uid int64) (*model.CloudRef, error) {
	var ref model.CloudRef
	err := db.Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).First(&ref).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &ref, nil
}

// SoftDelete removes the ref row (uid-checked). Source file/folder untouched.
func (r *RefRepo) SoftDelete(db *gorm.DB, id, uid int64) error {
	now := time.Now()
	res := db.Model(&model.CloudRef{}).
		Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).
		Updates(map[string]any{"deleted_at": now, "updated_at": now})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// MarkDead flips an alive ref to status='dead' (invalid at read time — the
// source side no longer resolves). Best-effort: callers are already on the
// 404 path, so a failed flip only costs one extra recheck next read.
func (r *RefRepo) MarkDead(db *gorm.DB, id int64) error {
	now := time.Now()
	return db.Model(&model.CloudRef{}).
		Where("id = ? AND status = 'alive'", id).
		Updates(map[string]any{"status": "dead", "updated_at": now}).Error
}
