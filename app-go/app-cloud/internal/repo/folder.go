package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

// FolderRepo — cloud_folders access (tree, CRUD, soft delete).
type FolderRepo struct{}

func NewFolderRepo() *FolderRepo { return &FolderRepo{} }

// ListByUID returns all active folders of a user (tree assembled in service).
func (r *FolderRepo) ListByUID(db *gorm.DB, uid int64) ([]model.CloudFolder, error) {
	var rows []model.CloudFolder
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).
		Order("COALESCE(sort_order, 0), id").Find(&rows).Error
	return rows, err
}

// GetByID returns one active folder (owner-checked).
func (r *FolderRepo) GetByID(db *gorm.DB, id int64, uid int64) (*model.CloudFolder, error) {
	var f model.CloudFolder
	err := db.Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).First(&f).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &f, nil
}

// Create inserts a folder; parent ownership is validated by the service.
func (r *FolderRepo) Create(db *gorm.DB, f *model.CloudFolder) error {
	now := time.Now()
	if f.CreatedAt == nil {
		f.CreatedAt = &now
	}
	if f.UpdatedAt == nil {
		f.UpdatedAt = &now
	}
	return db.Create(f).Error
}

// Update patches name and/or parent_id (owner-checked). Pass hasParent to
// distinguish "not provided" from "explicitly NULL" (move to root).
func (r *FolderRepo) Update(db *gorm.DB, id int64, uid int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	fields["updated_at"] = time.Now()
	res := db.Model(&model.CloudFolder{}).
		Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).Updates(fields)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// SubtreeIDs collects folder_id and (when includeChildren) all descendant
// ids via recursive CTE.
func (r *FolderRepo) SubtreeIDs(db *gorm.DB, id int64, uid int64, includeChildren bool) ([]int64, error) {
	if !includeChildren {
		return []int64{id}, nil
	}
	var ids []int64
	err := db.Raw(`
		WITH RECURSIVE subtree AS (
			SELECT id FROM cloud_folders
				WHERE id = ? AND uid = ? AND deleted_at IS NULL
			UNION ALL
			SELECT c.id FROM cloud_folders c
				JOIN subtree s ON c.parent_id = s.id
				WHERE c.deleted_at IS NULL
		)
		SELECT id FROM subtree`, id, uid).Scan(&ids).Error
	return ids, err
}

// SoftDeleteTree soft-deletes the folder (and its subtree when includeChildren,
// since files' folder_id would dangle otherwise).
func (r *FolderRepo) SoftDeleteTree(db *gorm.DB, ids []int64, uid int64) (int64, error) {
	now := time.Now()
	res := db.Model(&model.CloudFolder{}).
		Where("uid = ? AND id IN ?", uid, ids).
		Updates(map[string]any{"deleted_at": now, "updated_at": now})
	return res.RowsAffected, res.Error
}

// UpdateCounts recomputes video_count for every folder of a user from the
// live cloud_files rows (one-shot repair, parity with recalc_all_counts).
func (r *FolderRepo) UpdateCounts(db *gorm.DB, uid int64) error {
	return db.Exec(`
		UPDATE cloud_folders f
		SET video_count = (
			SELECT COUNT(*) FROM cloud_files cf
			WHERE cf.folder_id = f.id AND cf.deleted_at IS NULL
		)
		WHERE f.uid = ? AND f.deleted_at IS NULL`, uid).Error
}
