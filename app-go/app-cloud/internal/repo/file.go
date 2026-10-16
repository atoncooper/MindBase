// Package repo is the data-access layer for the cloud tables. Pure GORM
// queries — business rules live in internal/service.
package repo

import (
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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

// Create inserts the CloudFile row (called only on complete_upload) and
// bumps the cloud_quota counter in the same transaction.
func (r *FileRepo) Create(db *gorm.DB, f *model.CloudFile) error {
	now := time.Now()
	if f.CreatedAt == nil {
		f.CreatedAt = &now
	}
	if f.UpdatedAt == nil {
		f.UpdatedAt = &now
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(f).Error; err != nil {
			return err
		}
		return r.applyUsageDelta(tx, f.UID, f.FileSize)
	})
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
// until the sweeper purges them after purge_after_days) and moves the
// cloud_quota counter down in the same transaction.
func (r *FileRepo) SoftDelete(db *gorm.DB, uploadUUID string, uid int64) error {
	now := time.Now()
	return db.Transaction(func(tx *gorm.DB) error {
		var f model.CloudFile
		// Locking read serializes concurrent trash toggles of the same row.
		err := tx.Where("upload_uuid = ? AND uid = ? AND deleted_at IS NULL", uploadUUID, uid).
			Clauses(clause.Locking{Strength: "UPDATE"}).First(&f).Error
		if err != nil {
			return err // gorm.ErrRecordNotFound preserved for callers
		}
		if err := tx.Model(&model.CloudFile{}).Where("id = ?", f.ID).
			Updates(map[string]any{"deleted_at": now, "updated_at": now}).Error; err != nil {
			return err
		}
		return r.applyUsageDelta(tx, uid, -f.FileSize)
	})
}

// Restore undoes a soft delete (trash restore) and moves the cloud_quota
// counter back up in the same transaction.
func (r *FileRepo) Restore(db *gorm.DB, uploadUUID string, uid int64) error {
	return db.Transaction(func(tx *gorm.DB) error {
		var f model.CloudFile
		err := tx.Where("upload_uuid = ? AND uid = ? AND deleted_at IS NOT NULL", uploadUUID, uid).
			Clauses(clause.Locking{Strength: "UPDATE"}).First(&f).Error
		if err != nil {
			return err
		}
		if err := tx.Model(&model.CloudFile{}).Where("id = ?", f.ID).
			Updates(map[string]any{"deleted_at": nil, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return r.applyUsageDelta(tx, uid, f.FileSize)
	})
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
// given folders (folder delete cascade) and moves the cloud_quota counter
// down by exactly the flipped bytes, in one transaction. Returns affected
// file count.
func (r *FileRepo) SoftDeleteByFolderIDs(db *gorm.DB, uid int64, folderIDs []int64) (int64, error) {
	if len(folderIDs) == 0 {
		return 0, nil
	}
	now := time.Now()
	var affected int64
	err := db.Transaction(func(tx *gorm.DB) error {
		var sum int64
		// Locking aggregate over the matched rows: the counter delta matches
		// exactly the bytes this update flips (no interleaving soft-delete).
		if err := tx.Model(&model.CloudFile{}).
			Where("uid = ? AND folder_id IN ? AND deleted_at IS NULL", uid, folderIDs).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Select("COALESCE(SUM(file_size), 0)").
			Scan(&sum).Error; err != nil {
			return err
		}
		res := tx.Model(&model.CloudFile{}).
			Where("uid = ? AND folder_id IN ? AND deleted_at IS NULL", uid, folderIDs).
			Updates(map[string]any{"deleted_at": now, "updated_at": now})
		if res.Error != nil {
			return res.Error
		}
		affected = res.RowsAffected
		return r.applyUsageDelta(tx, uid, -sum)
	})
	return affected, err
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

// UsedBytes returns the user's active-bytes total for quota accounting.
// Fast path reads the cloud_quota counter (O(1), maintained transactionally
// by every mutation above); a missing row lazily bootstraps from the
// authoritative SUM. The daily reconciler heals any counter drift — the SUM
// stays the accounting authority.
func (r *FileRepo) UsedBytes(db *gorm.DB, uid int64) (int64, error) {
	var counter int64
	if err := db.Raw("SELECT used_bytes FROM cloud_quota WHERE uid = ?", uid).Scan(&counter).Error; err != nil {
		return 0, err
	}
	if counter != 0 {
		return counter, nil
	}
	// Zero counter: either a genuinely empty user or no row yet. Bootstrap
	// missing rows from SUM so the fast path sticks after the first hit.
	sum, err := r.sumActiveBytes(db, uid)
	if err != nil {
		return 0, err
	}
	var exists int64
	if err := db.Raw("SELECT COUNT(*) FROM cloud_quota WHERE uid = ?", uid).Scan(&exists).Error; err != nil {
		return 0, err
	}
	if exists == 0 {
		if err := r.applyUsageDelta(db, uid, sum); err != nil {
			return 0, err
		}
	}
	return sum, nil
}

// sumActiveBytes is the authoritative accounting query (legacy UsedBytes).
func (r *FileRepo) sumActiveBytes(db *gorm.DB, uid int64) (int64, error) {
	var used int64
	err := db.Model(&model.CloudFile{}).
		Where("uid = ? AND deleted_at IS NULL", uid).
		Session(&gorm.Session{}).
		Select("COALESCE(SUM(file_size), 0)").
		Scan(&used).Error
	return used, err
}

// applyUsageDelta moves the cloud_quota counter by delta (+upload / -trash).
// Upsert keeps the row self-seeding. Must run inside the mutation's
// transaction so the counter can never drift from cloud_files mid-crash.
func (r *FileRepo) applyUsageDelta(tx *gorm.DB, uid int64, delta int64) error {
	if delta == 0 {
		return nil
	}
	return tx.Exec(
		"INSERT INTO cloud_quota (uid, used_bytes, updated_at) VALUES (?, ?, NOW()) "+
			"ON DUPLICATE KEY UPDATE used_bytes = used_bytes + ?, updated_at = NOW()",
		uid, delta, delta).Error
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
