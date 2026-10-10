// Workspace data access — CRUD + binding expansion over workspaces /
// workspace_bindings / cloud_folders / cloud_files (all app-cloud-owned
// tables; CREATE-only schema, no ALTER). Port of the Python workspace
// repository's read/write slice the wire contract needs.
package repo

import (
	"context"
	"time"

	"app-cloud/internal/model"

	"gorm.io/gorm"
)

type WorkspaceRepo struct{}

func NewWorkspaceRepo() *WorkspaceRepo { return &WorkspaceRepo{} }

func (WorkspaceRepo) ListByUID(ctx context.Context, db *gorm.DB, uid int64) ([]model.Workspace, error) {
	var rows []model.Workspace
	err := db.WithContext(ctx).
		Where("uid = ? AND deleted_at IS NULL", uid).
		Order("updated_at DESC").
		Find(&rows).Error
	return rows, err
}

func (WorkspaceRepo) GetByID(ctx context.Context, db *gorm.DB, id int64, uid int64) (*model.Workspace, error) {
	var row model.Workspace
	err := db.WithContext(ctx).
		Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).
		First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &row, err
}

func (WorkspaceRepo) Create(ctx context.Context, db *gorm.DB, uid int64, name string, description, icon, color *string) (*model.Workspace, error) {
	now := time.Now().UTC()
	row := model.Workspace{UID: uid, Name: name, Description: description, Icon: icon, Color: color, CreatedAt: &now, UpdatedAt: &now}
	if err := db.WithContext(ctx).Create(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// Update sets only the provided (non-nil) fields and bumps updated_at.
func (WorkspaceRepo) Update(ctx context.Context, db *gorm.DB, id int64, uid int64, name, description, icon, color *string) (*model.Workspace, error) {
	row, err := WorkspaceRepo{}.GetByID(ctx, db, id, uid)
	if err != nil || row == nil {
		return row, err
	}
	updates := map[string]interface{}{"updated_at": time.Now().UTC()}
	if name != nil {
		updates["name"] = *name
	}
	if description != nil {
		updates["description"] = *description
	}
	if icon != nil {
		updates["icon"] = *icon
	}
	if color != nil {
		updates["color"] = *color
	}
	if err := db.WithContext(ctx).Model(&model.Workspace{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		return nil, err
	}
	return WorkspaceRepo{}.GetByID(ctx, db, id, uid)
}

// SoftDelete marks the row deleted; bindings are hard-deleted (parity).
func (WorkspaceRepo) SoftDelete(ctx context.Context, db *gorm.DB, id int64, uid int64) (bool, error) {
	res := db.WithContext(ctx).Model(&model.Workspace{}).
		Where("id = ? AND uid = ? AND deleted_at IS NULL", id, uid).
		Update("deleted_at", time.Now().UTC())
	if res.Error != nil {
		return false, res.Error
	}
	if res.RowsAffected == 0 {
		return false, nil
	}
	if err := db.WithContext(ctx).Where("workspace_id = ?", id).Delete(&model.WorkspaceBinding{}).Error; err != nil {
		return false, err
	}
	return true, nil
}

func (WorkspaceRepo) GetBindings(ctx context.Context, db *gorm.DB, workspaceID int64, uid int64) ([]model.WorkspaceBinding, error) {
	var rows []model.WorkspaceBinding
	err := db.WithContext(ctx).
		Where("workspace_id = ? AND uid = ?", workspaceID, uid).
		Order("id ASC").
		Find(&rows).Error
	return rows, err
}

func (WorkspaceRepo) GetBinding(ctx context.Context, db *gorm.DB, bindingID int64, workspaceID int64, uid int64) (*model.WorkspaceBinding, error) {
	var row model.WorkspaceBinding
	err := db.WithContext(ctx).
		Where("id = ? AND workspace_id = ? AND uid = ?", bindingID, workspaceID, uid).
		First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &row, err
}

func (WorkspaceRepo) AddBinding(ctx context.Context, db *gorm.DB, workspaceID int64, uid int64, bindType string, folderID *int64, uploadUUID *string, includeSubfolders bool) error {
	now := time.Now().UTC()
	return db.WithContext(ctx).Create(&model.WorkspaceBinding{
		WorkspaceID:       workspaceID,
		UID:               uid,
		BindType:          bindType,
		FolderID:          folderID,
		UploadUUID:        uploadUUID,
		IncludeSubfolders: includeSubfolders,
		CreatedAt:         &now,
	}).Error
}

func (WorkspaceRepo) RemoveBinding(ctx context.Context, db *gorm.DB, bindingID int64, workspaceID int64, uid int64) (bool, error) {
	res := db.WithContext(ctx).
		Where("id = ? AND workspace_id = ? AND uid = ?", bindingID, workspaceID, uid).
		Delete(&model.WorkspaceBinding{})
	return res.RowsAffected > 0, res.Error
}

// FolderExists reports folder ownership (binding validation).
func (WorkspaceRepo) FolderExists(ctx context.Context, db *gorm.DB, folderID int64, uid int64) (bool, error) {
	var n int64
	err := db.WithContext(ctx).Model(&model.CloudFolder{}).
		Where("id = ? AND uid = ? AND deleted_at IS NULL", folderID, uid).
		Count(&n).Error
	return n > 0, err
}

// FileExists reports file ownership by upload_uuid (binding validation).
func (WorkspaceRepo) FileExists(ctx context.Context, db *gorm.DB, uploadUUID string, uid int64) (bool, error) {
	var n int64
	err := db.WithContext(ctx).Model(&model.CloudFile{}).
		Where("upload_uuid = ? AND uid = ? AND deleted_at IS NULL", uploadUUID, uid).
		Count(&n).Error
	return n > 0, err
}

// ExpandAndRecalc expands the bindings into the vectorizable file set and
// persists file_count/chunk_count on the workspace row (runs only on binding
// add/remove, mirroring the Python service). Returns the expanded files.
func (WorkspaceRepo) ExpandAndRecalc(ctx context.Context, db *gorm.DB, workspaceID int64, uid int64) ([]model.CloudFile, error) {
	bindings, err := WorkspaceRepo{}.GetBindings(ctx, db, workspaceID, uid)
	if err != nil {
		return nil, err
	}
	folderIDs := make([]int64, 0)
	uploadUUIDs := make([]string, 0)
	for _, b := range bindings {
		if b.BindType == "folder" && b.FolderID != nil {
			folderIDs = append(folderIDs, *b.FolderID)
		}
		if b.BindType == "file" && b.UploadUUID != nil {
			uploadUUIDs = append(uploadUUIDs, *b.UploadUUID)
		}
	}
	// recursive folder descendants when include_subfolders
	if len(folderIDs) > 0 {
		var extra []struct {
			ID int64 `gorm:"column:id"`
		}
		err := db.WithContext(ctx).Raw(
			`WITH RECURSIVE folder_tree AS (
				SELECT id FROM cloud_folders WHERE id IN (?) AND uid = ? AND deleted_at IS NULL
				UNION ALL
				SELECT cf.id FROM cloud_folders cf JOIN folder_tree ft ON cf.parent_id = ft.id
				WHERE cf.deleted_at IS NULL
			) SELECT id FROM folder_tree`, folderIDs, uid).Scan(&extra).Error
		if err != nil {
			return nil, err
		}
		for _, e := range extra {
			folderIDs = append(folderIDs, e.ID)
		}
	}
	var files []model.CloudFile
	if len(folderIDs) == 0 && len(uploadUUIDs) == 0 {
		files = []model.CloudFile{}
	} else {
		scope := db.WithContext(ctx).Model(&model.CloudFile{}).
			Where("uid = ? AND vectorizable = 1 AND deleted_at IS NULL", uid)
		if len(folderIDs) > 0 && len(uploadUUIDs) > 0 {
			// grouped OR so the uid/vectorizable filter stays outer
			scope = scope.Where(scope.Where("folder_id IN (?)", folderIDs).Or("upload_uuid IN (?)", uploadUUIDs))
		} else if len(folderIDs) > 0 {
			scope = scope.Where("folder_id IN (?)", folderIDs)
		} else {
			scope = scope.Where("upload_uuid IN (?)", uploadUUIDs)
		}
		if err := scope.Order("created_at DESC").Find(&files).Error; err != nil {
			return nil, err
		}
	}
	chunks := 0
	uuids := make([]string, 0, len(files))
	for _, f := range files {
		uuids = append(uuids, f.UploadUUID)
		if f.VectorChunkCount != nil {
			chunks += *f.VectorChunkCount
		}
	}
	if err := db.WithContext(ctx).Model(&model.Workspace{}).Where("id = ?", workspaceID).
		Updates(map[string]interface{}{"file_count": len(uuids), "chunk_count": chunks, "updated_at": time.Now().UTC()}).Error; err != nil {
		return nil, err
	}
	return files, nil
}
