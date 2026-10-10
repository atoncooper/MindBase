// MySQL data access for the acquisition tables: video / video_versions /
// collection / favorite_folders / async_tasks. Pure GORM queries; business
// rules live in the service layer. RED LINE: no repo method writes the
// vectorized*/kg* columns of video (they belong to the Python AI stack).
package repo

import (
	"context"
	"encoding/json"
	"time"

	"app-bili/internal/model"

	"gorm.io/gorm"
)

// ── Video (ASR state machine) ────────────────────────────────────────

type VideoRepo struct{}

func NewVideoRepo() *VideoRepo { return &VideoRepo{} }

// GetByBvidCid returns the page row or nil.
func (VideoRepo) GetByBvidCid(ctx context.Context, db *gorm.DB, bvid string, cid int64) (*model.Video, error) {
	var v model.Video
	err := db.WithContext(ctx).Where("bvid = ? AND cid = ?", bvid, cid).First(&v).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// GetByBvidIndex resolves a page by (bvid, page_index) — reasr/update path.
func (VideoRepo) GetByBvidIndex(ctx context.Context, db *gorm.DB, bvid string, pageIndex int) (*model.Video, error) {
	var v model.Video
	err := db.WithContext(ctx).Where("bvid = ? AND page_index = ?", bvid, pageIndex).First(&v).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// ListByBvid returns all pages of a video ordered by page_index.
func (VideoRepo) ListByBvid(ctx context.Context, db *gorm.DB, bvid string) ([]model.Video, error) {
	var rows []model.Video
	err := db.WithContext(ctx).Where("bvid = ?", bvid).Order("page_index ASC").Find(&rows).Error
	return rows, err
}

// Create inserts a fresh page row (version=1, is_processed=false).
func (VideoRepo) Create(ctx context.Context, db *gorm.DB, v *model.Video) error {
	now := time.Now().UTC()
	v.CreatedAt = now
	v.UpdatedAt = now
	if v.Version == nil {
		ver := 1
		v.Version = &ver
	}
	return db.WithContext(ctx).Create(v).Error
}

// MarkProcessed is the ASR success transition: is_processed=true,
// content_source="asr", version=version+1 — one atomic UPDATE.
func (VideoRepo) MarkProcessed(ctx context.Context, db *gorm.DB, id int64, version int) error {
	return db.WithContext(ctx).Model(&model.Video{}).Where("id = ?", id).Updates(map[string]any{
		"is_processed":   true,
		"content_source": "asr",
		"version":        version + 1,
		"updated_at":     time.Now().UTC(),
	}).Error
}

// MarkUnprocessed is the failure safety: never leave is_processed=true with
// empty Mongo content (cross-store consistency guard).
func (VideoRepo) MarkUnprocessed(ctx context.Context, db *gorm.DB, id int64) error {
	return db.WithContext(ctx).Model(&model.Video{}).Where("id = ?", id).Updates(map[string]any{
		"is_processed":   false,
		"content_source": nil,
		"updated_at":     time.Now().UTC(),
	}).Error
}

// MarkUserEdit overwrites content metadata without bumping the version.
func (VideoRepo) MarkUserEdit(ctx context.Context, db *gorm.DB, id int64) error {
	return db.WithContext(ctx).Model(&model.Video{}).Where("id = ?", id).Updates(map[string]any{
		"is_processed":   true,
		"content_source": "user_edit",
		"updated_at":     time.Now().UTC(),
	}).Error
}

// ── VideoVersion ─────────────────────────────────────────────────────

type VideoVersionRepo struct{}

func NewVideoVersionRepo() *VideoVersionRepo { return &VideoVersionRepo{} }

// InsertLatest marks prior versions not-latest and inserts the new one.
func (VideoVersionRepo) InsertLatest(ctx context.Context, db *gorm.DB,
	bvid string, cid int64, pageIndex, version int, contentSource string) error {
	now := time.Now().UTC()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.VideoVersion{}).
			Where("bvid = ? AND cid = ? AND is_latest = ?", bvid, cid, true).
			Update("is_latest", false).Error; err != nil {
			return err
		}
		return tx.Create(&model.VideoVersion{
			BvID: bvid, CID: cid, PageIndex: pageIndex, Version: version,
			ContentSource: &contentSource, IsLatest: boolPtr(true), CreatedAt: now,
		}).Error
	})
}

// ListByBvidCid returns version rows newest-first.
func (VideoVersionRepo) ListByBvidCid(ctx context.Context, db *gorm.DB, bvid string, cid int64) ([]model.VideoVersion, error) {
	var rows []model.VideoVersion
	err := db.WithContext(ctx).Where("bvid = ? AND cid = ?", bvid, cid).
		Order("version DESC").Limit(100).Find(&rows).Error
	return rows, err
}

// ── Collection / favorite_folders ────────────────────────────────────

type CollectionRepo struct{}

func NewCollectionRepo() *CollectionRepo { return &CollectionRepo{} }

func (CollectionRepo) CountByMediaID(ctx context.Context, db *gorm.DB, mediaID int64) (int64, error) {
	var n int64
	err := db.WithContext(ctx).Model(&model.Collection{}).Where("media_id = ?", mediaID).Count(&n).Error
	return n, err
}

func (CollectionRepo) DeleteByMediaID(ctx context.Context, db *gorm.DB, mediaID int64) error {
	return db.WithContext(ctx).Where("media_id = ?", mediaID).Delete(&model.Collection{}).Error
}

func (CollectionRepo) BulkInsert(ctx context.Context, db *gorm.DB, rows []model.Collection) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for i := range rows {
		rows[i].CreatedAt = now
		rows[i].UpdatedAt = now
	}
	return db.WithContext(ctx).CreateInBatches(rows, 200).Error
}

// CountBvidUsage counts how many collection rows reference a bvid (removal
// safety: only delete vectors/content when the last reference disappears).
func (CollectionRepo) CountBvidUsage(ctx context.Context, db *gorm.DB, bvid string) (int64, error) {
	var n int64
	err := db.WithContext(ctx).Model(&model.Collection{}).Where("bvid = ?", bvid).Count(&n).Error
	return n, err
}

type FolderRepo struct{}

func NewFolderRepo() *FolderRepo { return &FolderRepo{} }

// UpsertFolder inserts or refreshes a folder row for (uid, media_id).
func (FolderRepo) UpsertFolder(ctx context.Context, db *gorm.DB,
	uid, mediaID int64, title string, mediaCount int, isDefault bool) (*model.FavoriteFolder, error) {
	now := time.Now().UTC()
	var folder model.FavoriteFolder
	err := db.WithContext(ctx).Where("uid = ? AND media_id = ?", uid, mediaID).First(&folder).Error
	if err == gorm.ErrRecordNotFound {
		folder = model.FavoriteFolder{
			UID: &uid, MediaID: mediaID, Title: title, MediaCount: &mediaCount,
			IsDefault: boolPtr(isDefault), CreatedAt: now, UpdatedAt: now,
		}
		if err := db.Create(&folder).Error; err != nil {
			return nil, err
		}
		return &folder, nil
	}
	if err != nil {
		return nil, err
	}
	updates := map[string]any{
		"title": title, "media_count": mediaCount,
		"is_default": isDefault, "updated_at": now,
	}
	if err := db.Model(&model.FavoriteFolder{}).Where("id = ?", folder.ID).Updates(updates).Error; err != nil {
		return nil, err
	}
	folder.Title = title
	folder.MediaCount = &mediaCount
	folder.IsDefault = boolPtr(isDefault)
	folder.UpdatedAt = now
	return &folder, nil
}

func (FolderRepo) ListByUID(ctx context.Context, db *gorm.DB, uid int64) ([]model.FavoriteFolder, error) {
	var rows []model.FavoriteFolder
	err := db.WithContext(ctx).Where("uid = ? AND deleted_at IS NULL", uid).
		Order("is_default DESC, id ASC").Find(&rows).Error
	return rows, err
}

func (FolderRepo) GetByID(ctx context.Context, db *gorm.DB, id int64) (*model.FavoriteFolder, error) {
	var f model.FavoriteFolder
	err := db.WithContext(ctx).First(&f, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (FolderRepo) UpdateSelected(ctx context.Context, db *gorm.DB, id int64, uid int64, selected bool) (bool, error) {
	res := db.WithContext(ctx).Model(&model.FavoriteFolder{}).
		Where("id = ? AND uid = ?", id, uid).Update("is_selected", selected)
	return res.RowsAffected > 0, res.Error
}

func (FolderRepo) SoftDelete(ctx context.Context, db *gorm.DB, id int64, uid int64) (bool, error) {
	now := time.Now().UTC()
	res := db.WithContext(ctx).Model(&model.FavoriteFolder{}).
		Where("id = ? AND uid = ?", id, uid).
		Updates(map[string]any{"deleted_at": now, "updated_at": now})
	return res.RowsAffected > 0, res.Error
}

func (FolderRepo) TouchSync(ctx context.Context, db *gorm.DB, id int64, mediaCount int) error {
	now := time.Now().UTC()
	return db.WithContext(ctx).Model(&model.FavoriteFolder{}).Where("id = ?", id).
		Updates(map[string]any{"media_count": mediaCount, "last_sync_at": now, "updated_at": now}).Error
}

// ── async_tasks ──────────────────────────────────────────────────────

type TaskRepo struct{}

func NewTaskRepo() *TaskRepo { return &TaskRepo{} }

func (TaskRepo) Create(ctx context.Context, db *gorm.DB, uid *int64, taskID, taskType, target string) (*model.AsyncTask, error) {
	now := time.Now().UTC()
	status := "pending"
	progress := 0
	t := &model.AsyncTask{
		UID: uid, TaskID: taskID, TaskType: taskType, Target: target,
		Status: &status, Progress: &progress, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.WithContext(ctx).Create(t).Error; err != nil {
		return nil, err
	}
	return t, nil
}

func (TaskRepo) GetByTaskID(ctx context.Context, db *gorm.DB, taskID string) (*model.AsyncTask, error) {
	var t model.AsyncTask
	err := db.WithContext(ctx).Where("task_id = ?", taskID).First(&t).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Start marks processing (progress=5).
func (TaskRepo) Start(ctx context.Context, db *gorm.DB, id int64) error {
	now := time.Now().UTC()
	progress := 5
	status := "processing"
	return db.WithContext(ctx).Model(&model.AsyncTask{}).Where("id = ?", id).
		Updates(map[string]any{"status": status, "progress": progress, "updated_at": now}).Error
}

// UpdateProgress advances progress/message (steps JSON replaced wholesale).
func (TaskRepo) UpdateProgress(ctx context.Context, db *gorm.DB, id int64, progress int, stepsJSON, resultJSON string) error {
	now := time.Now().UTC()
	updates := map[string]any{"progress": progress, "updated_at": now, "status": "processing"}
	if stepsJSON != "" {
		updates["steps"] = stepsJSON
	}
	if resultJSON != "" {
		updates["result"] = resultJSON
	}
	return db.WithContext(ctx).Model(&model.AsyncTask{}).Where("id = ?", id).Updates(updates).Error
}

// Complete / Fail finalize with completed_at (status-dependent stamping,
// parity with the Python repository).
func (TaskRepo) Complete(ctx context.Context, db *gorm.DB, id int64, resultJSON string) error {
	now := time.Now().UTC()
	status := "done"
	progress := 100
	return db.WithContext(ctx).Model(&model.AsyncTask{}).Where("id = ?", id).
		Updates(map[string]any{"status": status, "progress": progress,
			"result": resultJSON, "completed_at": now, "updated_at": now}).Error
}

func (TaskRepo) Fail(ctx context.Context, db *gorm.DB, id int64, errMsg string) error {
	now := time.Now().UTC()
	status := "failed"
	return db.WithContext(ctx).Model(&model.AsyncTask{}).Where("id = ?", id).
		Updates(map[string]any{"status": status, "error": errMsg,
			"completed_at": now, "updated_at": now}).Error
}

// FindActiveBuildByUID returns the pending/processing build row for a uid.
func (TaskRepo) FindActiveBuildByUID(ctx context.Context, db *gorm.DB, uid int64) (*model.AsyncTask, error) {
	var t model.AsyncTask
	err := db.WithContext(ctx).
		Where("uid = ? AND task_type = ? AND status IN (?, ?)", uid, "build", "pending", "processing").
		Order("id DESC").First(&t).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// MarshalJSON helper for nullable JSON columns.
func MustJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func boolPtr(b bool) *bool { return &b }
