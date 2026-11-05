package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/minio"
	"app-cloud/internal/metrics"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"
	"app-cloud/internal/utils"

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

// ASRStatusForMime — the initial asr_status of a freshly completed upload:
// only video/audio can be transcribed, everything else starts as
// not_supported so the UI never shows a pending badge that cannot resolve.
func ASRStatusForMime(mime string) string {
	m := strings.ToLower(strings.TrimSpace(mime))
	if strings.HasPrefix(m, "video/") || strings.HasPrefix(m, "audio/") {
		return "pending"
	}
	return "not_supported"
}

func mimeAllowed(mime string) bool {
	for _, p := range allowedMimePrefixes {
		if strings.HasPrefix(mime, p) {
			return true
		}
	}
	return false
}

// UploadPresignedItem is one chunk's presigned PUT target.
type UploadPresignedItem struct {
	ChunkIndex int64
	ChunkSize  int64
	URL        string
}

// UploadInitResult tells the caller how to upload the object in chunks.
type UploadInitResult struct {
	UploadUUID    string
	SessionUUID   string
	MinioUploadID string
	ChunkCount    int64
	ChunkSize     int64
	PresignedURLs []UploadPresignedItem
}

// UploadPart is one completed multipart part.
type UploadPart struct {
	PartNumber int
	ETag       string
}

// UploadCompleteResult acknowledges a finalized multipart upload.
type UploadCompleteResult struct {
	UploadUUID string
	ETag       string
	Status     string
}

// UploadResumeChunk is one chunk still to be (re)uploaded.
type UploadResumeChunk struct {
	ChunkIndex int64
	ChunkSize  int64
	URL        string
}

// UploadResumeResult re-issues presigned URLs for an interrupted upload.
type UploadResumeResult struct {
	UploadUUID    string
	MinioUploadID string
	PendingChunks []UploadResumeChunk
}

// UploadService — multipart upload lifecycle: init → presigned chunk PUTs →
// heartbeat → complete. Upload metadata lives in Redis only (TTL 1h); the
// cloud_files row is created on complete, so abandoned uploads leave no DB
// garbage. Parity with the Python CloudUploadService plus the new quota gate.
type UploadService struct {
	cfg     *config.Config
	db      *gorm.DB
	minio   *minio.Client
	rdb     redis.UniversalClient
	files   *repo.FileRepo
	quota   *QuotaService
	pending *PendingUploads
}

func NewUploadService(cfg *config.Config, db *gorm.DB, mc *minio.Client,
	rdb redis.UniversalClient, quota *QuotaService, pending *PendingUploads) *UploadService {
	return &UploadService{
		cfg: cfg, db: db, minio: mc, rdb: rdb,
		files: repo.NewFileRepo(), quota: quota, pending: pending,
	}
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
	fileSize int64, mimeType string, folderID *int64) (*UploadInitResult, error) {
	if !mimeAllowed(mimeType) {
		return nil, fmt.Errorf("Unsupported mime_type=%q", mimeType)
	}
	if fileSize <= 0 {
		return nil, fmt.Errorf("file_size must be positive, got %d", fileSize)
	}
	if fileSize > maxFileSize {
		return nil, fmt.Errorf("File too large: %d bytes (max %d)", fileSize, maxFileSize)
	}
	uploadUUID, err := utils.UUID7()
	if err != nil {
		return nil, err
	}
	sessionUUID, err := utils.UUID7()
	if err != nil {
		return nil, err
	}
	// Quota gate + in-flight reservation, atomically (Redis Lua): used +
	// pending reservations + fileSize must fit the tier quota. Parallel inits
	// are serialized in Redis and can no longer jointly overshoot.
	if err := s.quota.ReserveUpload(ctx, uid, uploadUUID, fileSize); err != nil {
		return nil, err
	}

	objectKey := fmt.Sprintf("%d/%s/file%s", uid, uploadUUID, extFromMime(mimeType))
	chunkCount := (fileSize + chunkSize - 1) / chunkSize

	minioUploadID, err := s.minio.CreateMultipartUpload(ctx, objectKey)
	if err != nil {
		slog.Error("[CLOUD_UPLOAD] minio create_multipart_upload failed", "err", err)
		s.pending.Remove(ctx, uid, uploadUUID) // release the reservation
		return nil, err
	}

	presigned := make([]UploadPresignedItem, 0, chunkCount)
	for p := int64(1); p <= chunkCount; p++ {
		u, err := s.minio.PresignUploadPart(ctx, objectKey, minioUploadID, int(p))
		if err != nil {
			slog.Error("[CLOUD_UPLOAD] presigned_url generation failed, aborting", "err", err)
			s.minio.AbortMultipartUpload(ctx, objectKey, minioUploadID)
			s.pending.Remove(ctx, uid, uploadUUID) // release the reservation
			return nil, err
		}
		presigned = append(presigned, UploadPresignedItem{ChunkIndex: p - 1, ChunkSize: chunkSize, URL: u})
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
		// No upload session without meta — release the quota reservation so
		// it does not linger until the pending-entry TTL prune.
		s.pending.Remove(ctx, uid, uploadUUID)
		return nil, fmt.Errorf("redis upload meta write: %w", err)
	}
	s.SetHeartbeat(ctx, sessionUUID, uploadUUID, uid)

	slog.Info("[CLOUD_UPLOAD] init_upload complete", "uid", uid,
		"filename", filename, "size", fileSize, "chunks", chunkCount,
		"upload_uuid", uploadUUID)

	return &UploadInitResult{
		UploadUUID:    uploadUUID,
		SessionUUID:   sessionUUID,
		MinioUploadID: minioUploadID,
		ChunkCount:    chunkCount,
		ChunkSize:     chunkSize,
		PresignedURLs: presigned,
	}, nil
}

// CompleteUpload finalises the multipart upload and creates the DB row.
func (s *UploadService) CompleteUpload(ctx context.Context, uploadUUID string,
	parts []UploadPart, uid int64) (*UploadCompleteResult, error) {
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

	// Size verification (quota-bypass guard): the declared file_size is
	// client input — a client could declare a small size to pass the quota
	// reserve, then upload far larger parts. Verify what actually landed in
	// MinIO; any mismatch violates the upload contract: remove the stray
	// object, release the reservation and the session, and store nothing.
	actualSize, serr := s.minio.ObjectSize(ctx, meta.ObjectKey)
	if serr != nil {
		slog.Error("[CLOUD_UPLOAD] post-complete stat failed — object unverifiable", "upload_uuid", uploadUUID, "err", serr)
		s.pending.Remove(ctx, uid, uploadUUID)
		metrics.UploadComplete.WithLabelValues("stat_error").Inc()
		return nil, fmt.Errorf("uploaded object could not be verified: %w", serr)
	}
	if actualSize != meta.FileSize {
		slog.Error("[CLOUD_UPLOAD] size mismatch — rejecting upload and removing object",
			"upload_uuid", uploadUUID, "uid", uid, "declared", meta.FileSize, "actual", actualSize)
		_ = s.minio.DeleteObject(ctx, meta.ObjectKey)
		_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
		s.pending.Remove(ctx, uid, uploadUUID)
		metrics.UploadComplete.WithLabelValues("size_mismatch").Inc()
		return nil, fmt.Errorf("Uploaded size mismatch: declared %d bytes, actual %d bytes — upload rejected", meta.FileSize, actualSize)
	}

	uploadStatus := "completed"
	// ASR only ever applies to video/audio. Every other file is marked
	// not_supported up front so the UI does not wait forever on a pending
	// badge that will never resolve.
	asrStatus := ASRStatusForMime(meta.MimeType)
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
		metrics.UploadComplete.WithLabelValues("db_error").Inc()
		return nil, err
	}
	_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
	s.pending.Remove(ctx, uid, uploadUUID)

	slog.Info("[CLOUD_UPLOAD] complete_upload done", "upload_uuid", uploadUUID, "etag", etag)
	metrics.UploadComplete.WithLabelValues("ok").Inc()

	// Vectorization is user-triggered (process / reprocess endpoints) — an
	// upload completion never enqueues pipeline tasks by itself.

	return &UploadCompleteResult{
		UploadUUID: uploadUUID,
		ETag:       etag,
		Status:     "completed",
	}, nil
}

// heartbeatSession — value stored under the heartbeat key: the reverse
// mapping (session → upload + owner) needed to renew the upload session
// itself on every beat.
type heartbeatSession struct {
	UploadUUID string `json:"upload_uuid"`
	UID        int64  `json:"uid"`
}

// SetHeartbeat registers a live heartbeat (5-min TTL) and stores the
// (upload, uid) mapping so Heartbeat can renew the upload meta key.
func (s *UploadService) SetHeartbeat(ctx context.Context, sessionUUID, uploadUUID string, uid int64) {
	payload, _ := json.Marshal(heartbeatSession{UploadUUID: uploadUUID, UID: uid})
	if err := s.rdb.Set(ctx, heartbeatKeyPrefix+sessionUUID, payload,
		time.Duration(heartbeatTTL)*time.Second).Err(); err != nil {
		slog.Warn("[CLOUD_UPLOAD] heartbeat Redis SETEX failed", "session_uuid", sessionUUID, "err", err)
	}
}

// Heartbeat refreshes a live upload session: the heartbeat key AND the upload
// meta TTL (session renewal). Previously only the heartbeat key was refreshed
// while the meta expired a fixed 1h after init — any upload outlasting that
// window failed complete/resume even while actively heartbeating (large files
// on slow links). Renewal is owner-checked (meta uid == caller uid) and also
// re-stamps the pending-ledger entry so an in-flight file keeps its quota
// reservation. Legacy "alive" string values (pre-renewal sessions) still
// refresh the beat key only and expire with their original meta TTL.
func (s *UploadService) Heartbeat(ctx context.Context, sessionUUID string, uid int64) bool {
	key := heartbeatKeyPrefix + sessionUUID
	raw, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		// Session lapsed (>5min without a beat): ack false so the client
		// treats the upload as dead and re-initialises via /resume.
		return false
	}
	var hs heartbeatSession
	if json.Unmarshal([]byte(raw), &hs) != nil || hs.UploadUUID == "" {
		// Legacy "alive" value — refresh the beat only.
		if expErr := s.rdb.Expire(ctx, key, time.Duration(heartbeatTTL)*time.Second).Err(); expErr != nil {
			slog.Warn("[CLOUD_UPLOAD] heartbeat expire failed", "session_uuid", sessionUUID, "err", expErr)
		}
		return true
	}
	if hs.UID != uid {
		// Not the owner: never renew someone else's upload session.
		return false
	}
	if err := s.rdb.Set(ctx, key, raw, time.Duration(heartbeatTTL)*time.Second).Err(); err != nil {
		slog.Warn("[CLOUD_UPLOAD] heartbeat refresh failed", "session_uuid", sessionUUID, "err", err)
	}
	if err := s.rdb.Expire(ctx, uploadKeyPrefix+hs.UploadUUID,
		time.Duration(uploadMetaTTL)*time.Second).Err(); err != nil {
		slog.Warn("[CLOUD_UPLOAD] upload meta renew failed", "upload_uuid", hs.UploadUUID, "err", err)
	}
	s.pending.Touch(ctx, uid, hs.UploadUUID)
	return true
}

// ResumeUpload returns fresh presigned URLs for all chunks.
func (s *UploadService) ResumeUpload(ctx context.Context, uploadUUID string, uid int64) (*UploadResumeResult, error) {
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
	pending := make([]UploadResumeChunk, 0, meta.ChunkCount)
	for p := int64(1); p <= meta.ChunkCount; p++ {
		u, err := s.minio.PresignUploadPart(ctx, meta.ObjectKey, meta.MinioUploadID, int(p))
		if err != nil {
			return nil, err
		}
		pending = append(pending, UploadResumeChunk{ChunkIndex: p - 1, ChunkSize: meta.ChunkSize, URL: u})
	}
	slog.Info("[CLOUD_UPLOAD] resume_upload", "upload_uuid", uploadUUID, "chunks", len(pending))
	return &UploadResumeResult{
		UploadUUID:    uploadUUID,
		MinioUploadID: meta.MinioUploadID,
		PendingChunks: pending,
	}, nil
}
