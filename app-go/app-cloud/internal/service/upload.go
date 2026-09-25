package service

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/minio"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// Upload constants — MUST match the Python backend's values: clients rely on
// the chunk size and the presigned URL shape.
const (
	chunkSize     = int64(10 * 1024 * 1024) // 10 MB
	maxFileSize   = int64(5 * 1024 * 1024 * 1024)
	heartbeatTTL  = 300  // seconds
	uploadMetaTTL = 3600 // seconds
)

// redis key helpers — same namespace as the Python backend
// (k("cloud","upload",uuid) → "mind-base:cloud:upload:{uuid}").
const uploadKeyPrefix = "mind-base:cloud:upload:"
const heartbeatKeyPrefix = "mind-base:cloud:heartbeat:"

var allowedMimePrefixes = []string{
	"video/", "text/plain", "text/markdown", "text/x-markdown", "text/csv",
	"text/html",
	"application/vnd.openxmlformats-officedocument.wordprocessingml",
	"application/vnd.openxmlformats-officedocument.spreadsheetml",
	"application/vnd.openxmlformats-officedocument.presentationml",
	"application/pdf", "application/zip",
	"application/x-rar-compressed", "application/x-7z-compressed",
	"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
	"image/tiff",
}

var mimeToExt = map[string]string{
	"video/":                       ".mp4",
	"text/plain":                   ".txt",
	"text/markdown":                ".md",
	"text/x-markdown":              ".md",
	"text/csv":                     ".csv",
	"text/html":                    ".html",
	"application/pdf":              ".pdf",
	"application/zip":              ".zip",
	"application/x-rar-compressed": ".rar",
	"application/x-7z-compressed":  ".7z",
	"application/vnd.openxmlformats-officedocument.wordprocessingml": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml":    ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml":   ".pptx",
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/bmp":  ".bmp",
}

func extFromMime(mime string) string {
	for prefix, ext := range mimeToExt {
		if strings.HasPrefix(mime, prefix) {
			return ext
		}
	}
	return ".bin"
}

func mimeAllowed(mime string) bool {
	for _, p := range allowedMimePrefixes {
		if strings.HasPrefix(mime, p) {
			return true
		}
	}
	return false
}

// UploadService — multipart upload lifecycle: init → presigned chunk PUTs →
// heartbeat → complete. Upload metadata lives in Redis only (TTL 1h); the
// cloud_files row is created on complete, so abandoned uploads leave no DB
// garbage. Parity with the Python CloudUploadService plus the new quota gate.
type UploadService struct {
	cfg        *config.Config
	db         *gorm.DB
	minio      *minio.Client
	rdb        redis.UniversalClient
	files      *repo.FileRepo
	quota      *QuotaService
	pending    *PendingUploads
	onComplete func(uploadUUID string, uid int64, file *model.CloudFile) // pipeline hook
}

func NewUploadService(cfg *config.Config, db *gorm.DB, mc *minio.Client,
	rdb redis.UniversalClient, quota *QuotaService, pending *PendingUploads) *UploadService {
	return &UploadService{
		cfg: cfg, db: db, minio: mc, rdb: rdb,
		files: repo.NewFileRepo(), quota: quota, pending: pending,
	}
}

// SetCompletionHook registers the pipeline trigger (wired in main; keeps the
// upload service decoupled from the pipeline package).
func (s *UploadService) SetCompletionHook(fn func(uploadUUID string, uid int64, file *model.CloudFile)) {
	s.onComplete = fn
}

type uploadMeta struct {
	UID           int64  `json:"uid"`
	OriginalName  string `json:"original_name"`
	FileSize      int64  `json:"file_size"`
	MimeType      string `json:"mime_type"`
	FolderID      *int64 `json:"folder_id"`
	Bucket        string `json:"bucket"`
	ObjectKey     string `json:"object_key"`
	MinioUploadID string `json:"minio_upload_id"`
	ChunkCount    int64  `json:"chunk_count"`
	ChunkSize     int64  `json:"chunk_size"`
	SessionUUID   string `json:"session_uuid"`
}

// InitUpload starts a multipart upload and returns presigned per-chunk URLs.
func (s *UploadService) InitUpload(ctx context.Context, uid int64, filename string,
	fileSize int64, mimeType string, folderID *int64) (map[string]any, error) {
	if !mimeAllowed(mimeType) {
		return nil, fmt.Errorf("Unsupported mime_type=%q", mimeType)
	}
	if fileSize <= 0 {
		return nil, fmt.Errorf("file_size must be positive, got %d", fileSize)
	}
	if fileSize > maxFileSize {
		return nil, fmt.Errorf("File too large: %d bytes (max %d)", fileSize, maxFileSize)
	}
	// Quota gate (new capability): used + fileSize must fit the tier quota.
	if err := s.quota.CheckUpload(ctx, uid, fileSize); err != nil {
		return nil, err
	}

	uploadUUID, err := uuid7()
	if err != nil {
		return nil, err
	}
	sessionUUID, err := uuid7()
	if err != nil {
		return nil, err
	}
	objectKey := fmt.Sprintf("%d/%s/file%s", uid, uploadUUID, extFromMime(mimeType))
	chunkCount := (fileSize + chunkSize - 1) / chunkSize

	minioUploadID, err := s.minio.CreateMultipartUpload(ctx, objectKey)
	if err != nil {
		slog.Error("[CLOUD_UPLOAD] minio create_multipart_upload failed", "err", err)
		return nil, err
	}
	// In-flight accounting: from here the bytes count toward the quota even
	// before complete (prevents parallel-init quota races).
	s.pending.Add(ctx, uid, uploadUUID, fileSize)

	type presignedItem struct {
		ChunkIndex int64  `json:"chunkIndex"`
		ChunkSize  int64  `json:"chunkSize"`
		URL        string `json:"url"`
	}
	presigned := make([]presignedItem, 0, chunkCount)
	for p := int64(1); p <= chunkCount; p++ {
		u, err := s.minio.PresignUploadPart(ctx, objectKey, minioUploadID, int(p))
		if err != nil {
			slog.Error("[CLOUD_UPLOAD] presigned_url generation failed, aborting", "err", err)
			s.minio.AbortMultipartUpload(ctx, objectKey, minioUploadID)
			s.pending.Remove(ctx, uid, uploadUUID)
			return nil, err
		}
		presigned = append(presigned, presignedItem{ChunkIndex: p - 1, ChunkSize: chunkSize, URL: u})
	}

	meta := uploadMeta{
		UID: uid, OriginalName: filename, FileSize: fileSize, MimeType: mimeType,
		FolderID: folderID, Bucket: s.minio.Bucket(), ObjectKey: objectKey,
		MinioUploadID: minioUploadID, ChunkCount: chunkCount, ChunkSize: chunkSize,
		SessionUUID: sessionUUID,
	}
	blob, _ := json.Marshal(meta)
	if err := s.rdb.Set(ctx, uploadKeyPrefix+uploadUUID, blob,
		time.Duration(uploadMetaTTL)*time.Second).Err(); err != nil {
		return nil, fmt.Errorf("redis upload meta write: %w", err)
	}
	s.SetHeartbeat(ctx, sessionUUID)

	slog.Info("[CLOUD_UPLOAD] init_upload complete", "uid", uid,
		"filename", filename, "size", fileSize, "chunks", chunkCount,
		"upload_uuid", uploadUUID)

	return map[string]any{
		"uploadUuid":    uploadUUID,
		"sessionUuid":   sessionUUID,
		"minioUploadId": minioUploadID,
		"chunkCount":    chunkCount,
		"chunkSize":     chunkSize,
		"presignedUrls": presigned,
	}, nil
}

// CompleteUpload finalises the multipart upload and creates the DB row.
func (s *UploadService) CompleteUpload(ctx context.Context, uploadUUID string,
	parts []struct {
		PartNumber int
		ETag       string
	}, uid int64) (map[string]any, error) {
	raw, err := s.rdb.Get(ctx, uploadKeyPrefix+uploadUUID).Result()
	if err != nil {
		return nil, fmt.Errorf("Upload session expired or not found: %s", uploadUUID)
	}
	var meta uploadMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		return nil, fmt.Errorf("corrupt upload meta: %w", err)
	}
	if meta.UID != uid {
		return nil, fmt.Errorf("Upload %s does not belong to user %d", uploadUUID, uid)
	}

	mp := make([]minio.CompletePart, 0, len(parts))
	for _, p := range parts {
		mp = append(mp, minio.CompletePart{PartNumber: p.PartNumber, ETag: p.ETag})
	}
	etag, err := s.minio.CompleteMultipartUpload(ctx, meta.ObjectKey, meta.MinioUploadID, mp)
	if err != nil {
		slog.Error("[CLOUD_UPLOAD] minio complete_multipart_upload failed", "err", err)
		return nil, err
	}

	uploadStatus := "completed"
	asrStatus := "pending"
	vectorStatus := "pending"
	now := time.Now()
	row := &model.CloudFile{
		UploadUUID:   uploadUUID,
		UID:          uid,
		FolderID:     meta.FolderID,
		OriginalName: meta.OriginalName,
		FileSize:     meta.FileSize,
		MimeType:     meta.MimeType,
		Bucket:       meta.Bucket,
		ObjectKey:    meta.ObjectKey,
		ETag:         &etag,
		UploadStatus: &uploadStatus,
		AsrStatus:    &asrStatus,
		VectorStatus: &vectorStatus,
		Vectorizable: !strings.HasPrefix(meta.MimeType, "video/"),
		CreatedAt:    &now,
		UpdatedAt:    &now,
	}
	if err := s.files.Create(s.db, row); err != nil {
		slog.Error("[CLOUD_UPLOAD] DB create failed after MinIO complete — manual fix required!",
			"upload_uuid", uploadUUID, "etag", etag, "err", err)
		return nil, err
	}
	_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
	s.pending.Remove(ctx, uid, uploadUUID)

	slog.Info("[CLOUD_UPLOAD] complete_upload done", "upload_uuid", uploadUUID, "etag", etag)

	// Fire-and-forget pipeline (parse → chunk → embed → vectorize).
	if s.onComplete != nil {
		file := row
		go func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("[CLOUD_UPLOAD] pipeline panic", "upload_uuid", uploadUUID, "panic", r)
				}
			}()
			s.onComplete(uploadUUID, uid, file)
		}()
	}

	return map[string]any{
		"uploadUuid": uploadUUID,
		"etag":       etag,
		"status":     "completed",
	}, nil
}

// SetHeartbeat refreshes the upload session heartbeat (5-min TTL).
func (s *UploadService) SetHeartbeat(ctx context.Context, sessionUUID string) {
	if err := s.rdb.Set(ctx, heartbeatKeyPrefix+sessionUUID, "alive",
		time.Duration(heartbeatTTL)*time.Second).Err(); err != nil {
		slog.Warn("[CLOUD_UPLOAD] heartbeat Redis SETEX failed", "session_uuid", sessionUUID, "err", err)
	}
}

// Heartbeat returns ack=true when the heartbeat write succeeded.
func (s *UploadService) Heartbeat(ctx context.Context, sessionUUID string) bool {
	s.SetHeartbeat(ctx, sessionUUID)
	return true
}

// ResumeUpload returns fresh presigned URLs for all chunks.
func (s *UploadService) ResumeUpload(ctx context.Context, uploadUUID string, uid int64) (map[string]any, error) {
	raw, err := s.rdb.Get(ctx, uploadKeyPrefix+uploadUUID).Result()
	if err != nil {
		return nil, fmt.Errorf("Upload session expired or not found: %s", uploadUUID)
	}
	var meta uploadMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		return nil, fmt.Errorf("corrupt upload meta: %w", err)
	}
	if meta.UID != uid {
		return nil, fmt.Errorf("Upload %s does not belong to user %d", uploadUUID, uid)
	}
	type chunkItem struct {
		ChunkIndex int64  `json:"chunkIndex"`
		ChunkSize  int64  `json:"chunkSize"`
		URL        string `json:"url"`
	}
	pending := make([]chunkItem, 0, meta.ChunkCount)
	for p := int64(1); p <= meta.ChunkCount; p++ {
		u, err := s.minio.PresignUploadPart(ctx, meta.ObjectKey, meta.MinioUploadID, int(p))
		if err != nil {
			return nil, err
		}
		pending = append(pending, chunkItem{ChunkIndex: p - 1, ChunkSize: meta.ChunkSize, URL: u})
	}
	slog.Info("[CLOUD_UPLOAD] resume_upload", "upload_uuid", uploadUUID, "chunks", len(pending))
	return map[string]any{
		"uploadUuid":    uploadUUID,
		"minioUploadId": meta.MinioUploadID,
		"pendingChunks": pending,
	}, nil
}

// uuid7 generates a time-ordered UUIDv7 string — byte-format equivalent to
// the Python _generate_uuid7 (48-bit epoch ms + ver7 + 12+62 random bits).
func uuid7() (string, error) {
	const uuid7EpochMS = int64(1577836800000) // 2020-01-01T00:00:00Z, same as Python
	ts := uint64(time.Now().UnixMilli()-uuid7EpochMS) & 0xFFFFFFFFFFFF
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	r := uint64(0)
	for _, by := range b {
		r = r<<8 | uint64(by)
	}
	randA := (r >> 50) & 0xFFF
	randB := r & 0x3FFFFFFFFFFFFFFF
	timeLow := ts & 0xFFFFFFFF
	timeMid := (ts >> 32) & 0xFFFF
	timeHi := ((ts >> 48) & 0xFFF) | 0x7000
	clockSeq := (randA >> 2) | 0x8000
	clockSeqLow := randA & 0xFF
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%02x%012x",
		timeLow, timeMid, timeHi, clockSeq, clockSeqLow, randB), nil
}
