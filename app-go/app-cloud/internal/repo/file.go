// Package repo is the data-access layer for the cloud tables. Pure GORM
// queries — business rules live in internal/service.
package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// FileRepo — cloud_files access.
type FileRepo struct{}

func NewFileRepo() *FileRepo { return &FileRepo{} }

// GetByID returns the active (non-deleted) file row for (id, uid).
func (r *FileRepo) GetByID(db *gorm.DB, id int64, uid int64) (*model.CloudFile, error) {
	var f model.CloudFile
	err := db.Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).First(&f).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &f, nil
}

// GetByUUID returns the active (non-deleted) file row for (uuid, uid).
func (r *FileRepo) GetByUUID(db *gorm.DB, uploadUUID string, uid int64) (*model.CloudFile, error) {
	var f model.CloudFile
	err := db.Where("upload_uuid = ? AND uid = ? AND deleted_at IS NULL", uploadUUID, uid).First(&f).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &f, nil
}

// Create inserts the CloudFile row (called only on complete_upload).
func (r *FileRepo) Create(db *gorm.DB, f *model.CloudFile) error {
	now := time.Now()
	if f.CreatedAt == nil {
		f.CreatedAt = &now
	}
	if f.UpdatedAt == nil {
		f.UpdatedAt = &now
	}
	return db.Create(f).Error
}

// UpdateMeta patches title/description/tags/folder_id (owner-checked).
// Only non-nil entries are applied; use UpdateMetaExplicit for "set to NULL".
func (r *FileRepo) UpdateMeta(db *gorm.DB, uploadUUID string, uid int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	fields["updated_at"] = time.Now()
	res := db.Model(&model.CloudFile{}).
		Where("upload_uuid = ? AND uid = ? AND deleted_at IS NULL", uploadUUID, uid).
		Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// SoftDelete marks the file deleted (trash semantics: objects stay in MinIO
// until the sweeper purges them after purge_after_days).
func (r *FileRepo) SoftDelete(db *gorm.DB, uploadUUID string, uid int64) error {
	now := time.Now()
	res := db.Model(&model.CloudFile{}).
		Where("upload_uuid = ? AND uid = ? AND deleted_at IS NULL", uploadUUID, uid).
		Updates(map[string]any{"deleted_at": now, "updated_at": now})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// Restore undoes a soft delete (trash restore).
func (r *FileRepo) Restore(db *gorm.DB, uploadUUID string, uid int64) error {
	res := db.Model(&model.CloudFile{}).
		Where("upload_uuid = ? AND uid = ? AND deleted_at IS NOT NULL", uploadUUID, uid).
		Updates(map[string]any{"deleted_at": nil, "updated_at": time.Now()})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// ListByFolder returns a page of active files (root when folderID is nil),
// whitelisted sort columns only.
func (r *FileRepo) ListByFolder(db *gorm.DB, uid int64, folderID *int64,
	page, pageSize int, sortCol, order string) ([]model.CloudFile, int64, error) {
	q := db.Model(&model.CloudFile{}).Where("uid = ? AND deleted_at IS NULL", uid)
	if folderID != nil {
		q = q.Where("folder_id = ?", *folderID)
	} else {
		q = q.Where("folder_id IS NULL")
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []model.CloudFile
	err := q.Order(safeSort(sortCol) + " " + safeOrder(order) + ", id DESC").
		Offset((page - 1) * pageSize).Limit(pageSize).Find(&rows).Error
	return rows, total, err
}

// SoftDeleteByFolderIDs trash-soft-deletes every active file inside the
// given folders (folder delete cascade). Returns affected file count.
func (r *FileRepo) SoftDeleteByFolderIDs(db *gorm.DB, uid int64, folderIDs []int64) (int64, error) {
	if len(folderIDs) == 0 {
		return 0, nil
	}
	now := time.Now()
	res := db.Model(&model.CloudFile{}).
		Where("uid = ? AND folder_id IN ? AND deleted_at IS NULL", uid, folderIDs).
		Updates(map[string]any{"deleted_at": now, "updated_at": now})
	return res.RowsAffected, res.Error
}

// ListTrash returns soft-deleted files (newest deletion first).
func (r *FileRepo) ListTrash(db *gorm.DB, uid int64) ([]model.CloudFile, error) {
	var rows []model.CloudFile
	err := db.Where("uid = ? AND deleted_at IS NOT NULL", uid).
		Order("deleted_at DESC").Find(&rows).Error
	return rows, err
}

// SearchByName does a substring match on original_name / title (active files).
func (r *FileRepo) SearchByName(db *gorm.DB, uid int64, pattern string, limit int) ([]model.CloudFile, error) {
	var rows []model.CloudFile
	like := "%" + pattern + "%"
	err := db.Where(
		"uid = ? AND deleted_at IS NULL AND (original_name LIKE ? OR title LIKE ?)",
		uid, like, like,
	).Order("created_at DESC").Limit(limit).Find(&rows).Error
	return rows, err
}

// UsedBytes sums active file sizes for quota accounting.
func (r *FileRepo) UsedBytes(db *gorm.DB, uid int64) (int64, error) {
	var used int64
	err := db.Model(&model.CloudFile{}).
		Where("uid = ? AND deleted_at IS NULL", uid).
		Session(&gorm.Session{}).
		Select("COALESCE(SUM(file_size), 0)").
		Scan(&used).Error
	return used, err
}

// ListPurgeable returns soft-deleted rows whose deleted_at is older than
// `olderThan` (trash sweeper input).
func (r *FileRepo) ListPurgeable(db *gorm.DB, olderThan time.Time, limit int) ([]model.CloudFile, error) {
	var rows []model.CloudFile
	err := db.Where("deleted_at IS NOT NULL AND deleted_at < ?", olderThan).
		Limit(limit).Find(&rows).Error
	return rows, err
}

// HardDelete removes the DB row entirely (post-purge bookkeeping).
func (r *FileRepo) HardDelete(db *gorm.DB, id int64) error {
	return db.Where("id = ?", id).Delete(&model.CloudFile{}).Error
}

// safeSort whitelists sort columns (query params are user input).
func safeSort(col string) string {
	switch col {
	case "file_size", "original_name", "mime_type":
		return col
	default:
		return "created_at"
	}
}

func safeOrder(order string) string {
	if order == "asc" {
		return "ASC"
	}
	return "DESC"
}
