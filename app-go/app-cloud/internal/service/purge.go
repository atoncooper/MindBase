package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"app-cloud/internal/minio"
	"app-cloud/internal/model"
	"app-cloud/internal/mongostore"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

func logErr(msg, op, uploadUUID string, v any) {
	slog.Error(msg, "op", op, "upload_uuid", uploadUUID, "detail", v)
}

// PurgeService — physical deletion across all three stores (MinIO object,
// Mongo parsed text, Milvus vectors) + hard DB row delete. Used by the trash
// sweeper (deleted_at older than purge_after_days) and the explicit purge
// endpoints.
type PurgeService struct {
	db       *gorm.DB
	minio    *minio.Client
	mongo    *mongostore.MongoStore
	files    *repo.FileRepo
	pipeline *Pipeline // nil-tolerant: Milvus delete skipped when absent
}

func NewPurgeService(db *gorm.DB, mc *minio.Client, mongo *mongostore.MongoStore, pipeline *Pipeline) *PurgeService {
	return &PurgeService{db: db, minio: mc, mongo: mongo, files: repo.NewFileRepo(), pipeline: pipeline}
}

// PurgeFile physically deletes one soft-deleted file (owner-checked).
func (s *PurgeService) PurgeFile(ctx context.Context, uploadUUID string, uid int64) error {
	var f model.CloudFile
	err := s.db.Where("upload_uuid = ? AND uid = ? AND deleted_at IS NOT NULL", uploadUUID, uid).
		First(&f).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		return err
	}
	return s.purgeRow(ctx, &f)
}

// PurgeAllForUser empties the user's trash; returns the purged count.
func (s *PurgeService) PurgeAllForUser(ctx context.Context, uid int64) (int, error) {
	var rows []model.CloudFile
	if err := s.db.Where("uid = ? AND deleted_at IS NOT NULL", uid).Find(&rows).Error; err != nil {
		return 0, err
	}
	count := 0
	for i := range rows {
		if err := s.purgeRow(ctx, &rows[i]); err == nil {
			count++
		}
	}
	return count, nil
}

// PurgeExpired is the sweeper entry: physically deletes rows soft-deleted
// more than `olderThan` ago. Returns the number purged.
func (s *PurgeService) PurgeExpired(ctx context.Context, olderThan time.Time, batch int) (int, error) {
	var rows []model.CloudFile
	if err := s.db.Where("deleted_at IS NOT NULL AND deleted_at < ?", olderThan).
		Limit(batch).Find(&rows).Error; err != nil {
		return 0, err
	}
	count := 0
	for i := range rows {
		if err := s.purgeRow(ctx, &rows[i]); err == nil {
			count++
		}
	}
	return count, nil
}

func (s *PurgeService) purgeRow(ctx context.Context, f *model.CloudFile) error {
	// 1. MinIO object (source of truth for the bytes)
	if err := s.minio.DeleteObject(ctx, f.ObjectKey); err != nil {
		slog.Warn("[CLOUD_PURGE] minio delete failed", "upload_uuid", f.UploadUUID, "err", err)
		// keep the row so the sweeper retries; do NOT hard-delete on failure
		return err
	}
	// 2. Milvus vectors
	if s.pipeline != nil {
		if err := s.pipeline.DeleteChunks(ctx, f.UploadUUID); err != nil {
			slog.Warn("[CLOUD_PURGE] milvus delete failed", "upload_uuid", f.UploadUUID, "err", err)
		}
	}
	// 3. Mongo parsed text
	if err := s.mongo.DeleteParsedDocument(ctx, f.UploadUUID); err != nil {
		slog.Warn("[CLOUD_PURGE] mongo delete failed", "upload_uuid", f.UploadUUID, "err", err)
	}
	// 4. DB row
	if err := s.files.HardDelete(s.db, f.ID); err != nil {
		slog.Warn("[CLOUD_PURGE] db hard delete failed", "upload_uuid", f.UploadUUID, "err", err)
		return err
	}
	slog.Info("[CLOUD_PURGE] purged", "upload_uuid", f.UploadUUID, "uid", f.UID)
	return nil
}
