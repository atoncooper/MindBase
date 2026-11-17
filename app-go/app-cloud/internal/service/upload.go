package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
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

// Upload deadline queue: SHARDED Redis ZSETs (durable, no keyspace pub/sub).
// init schedules <uid>:<upload_uuid> with score = deadline ms; heartbeat/resume
// renew the score; a successful settlement (complete or MinIO webhook) removes
// the member. A periodic sweeper (RunDeadlineSweeper) atomically claims due
// members (Lua: deadline -> processing with visibility timeout), reconciles
// MinIO vs DB for that single upload, and batch-deletes A-type orphans.
const (
	uploadDeadlinePrefix   = "mind-base:cloud:upload:deadline:"
	uploadProcessingPrefix = "mind-base:cloud:upload:processing:"
	uploadDeadlineShards   = 64
)

func uploadShard(uid int64) int {
	return int(uint64(uid) % uploadDeadlineShards)
}

func uploadDeadlineKey(shard int) string {
	return uploadDeadlinePrefix + strconv.Itoa(shard)
}

func uploadProcessingKey(shard int) string {
	return uploadProcessingPrefix + strconv.Itoa(shard)
}

func deadlineMember(uid int64, uploadUUID string) string {
	return strconv.FormatInt(uid, 10) + ":" + uploadUUID
}

// ParseDeadlineMember extracts (uid, uploadUUID) from a deadline member.
// Exported for tests.
func ParseDeadlineMember(member string) (int64, string, bool) {
	parts := strings.SplitN(member, ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return 0, "", false
	}
	uid, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || uid <= 0 {
		return 0, "", false
	}
	return uid, parts[1], true
}

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
	// sweepRecentGuard: objects modified within this window are never swept
	// (complete-vs-expiry race guard); the upload is rescheduled instead.
	sweepRecentGuard time.Duration
}

func NewUploadService(cfg *config.Config, db *gorm.DB, mc *minio.Client,
	rdb redis.UniversalClient, quota *QuotaService, pending *PendingUploads) *UploadService {
	return &UploadService{
		cfg: cfg, db: db, minio: mc, rdb: rdb,
		files: repo.NewFileRepo(), quota: quota, pending: pending,
		sweepRecentGuard: time.Duration(cfg.Upload.SweepRecentGuardSeconds) * time.Second,
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
	// Deadline queue: if neither complete nor the MinIO webhook settles this
	// upload within the session window, the sweeper reclaims it.
	s.ScheduleUploadDeadline(ctx, uid, uploadUUID,
		time.Now().Add(time.Duration(uploadMetaTTL)*time.Second))

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
		// The MinIO webhook may have settled this upload and dropped the
		// session before the client's complete call landed (the two settlement
		// paths race by design). If the DB row exists the upload is already
		// finalised — report success instead of "session expired".
		if row, gerr := s.files.GetByUUID(s.db, uploadUUID, uid); gerr == nil && row != nil {
			etag := ""
			if row.ETag != nil {
				etag = *row.ETag
			}
			metrics.UploadComplete.WithLabelValues("already_settled").Inc()
			s.CancelUploadDeadline(ctx, uid, uploadUUID)
			return &UploadCompleteResult{UploadUUID: uploadUUID, ETag: etag, Status: "completed"}, nil
		}
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

	created, ferr := s.finalizeUpload(ctx, uploadUUID, meta, etag)
	if ferr != nil {
		return nil, ferr
	}
	if created {
		slog.Info("[CLOUD_UPLOAD] complete_upload done", "upload_uuid", uploadUUID, "etag", etag)
		metrics.UploadComplete.WithLabelValues("ok").Inc()
	} else {
		// The webhook settled it first: same row, quota charged exactly once.
		slog.Info("[CLOUD_UPLOAD] complete_upload already settled (webhook won)", "upload_uuid", uploadUUID)
		metrics.UploadComplete.WithLabelValues("duplicate").Inc()
	}

	// Vectorization is user-triggered (process / reprocess endpoints) — an
	// upload completion never enqueues pipeline tasks by itself.

	return &UploadCompleteResult{
		UploadUUID: uploadUUID,
		ETag:       etag,
		Status:     "completed",
	}, nil
}

// uploadObjectKeyRE matches cloud upload object keys:
// "<uid>/<uploadUUID>/file<ext>" (same shape the Python backend produced).
var uploadObjectKeyRE = regexp.MustCompile(
	`^(\d{1,20})/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/`)

// ParseUploadObjectKey extracts (uid, uploadUUID) from a cloud object key.
// Exported for tests and for the orphan reconciler.
func ParseUploadObjectKey(key string) (int64, string, bool) {
	m := uploadObjectKeyRE.FindStringSubmatch(key)
	if len(m) != 3 {
		return 0, "", false
	}
	uid, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || uid <= 0 {
		return 0, "", false
	}
	return uid, strings.ToLower(m[2]), true
}

// finalizeUpload is the single idempotent settlement primitive: insert the
// cloud_files row + bump cloud_quota exactly once, then drop the Redis upload
// session and the in-flight quota reservation. It is called by BOTH the client
// complete endpoint and the MinIO bucket-notification webhook, which race by
// design (unique upload_uuid index + ON DUPLICATE KEY ensures one charge).
func (s *UploadService) finalizeUpload(ctx context.Context, uploadUUID string, meta uploadMeta, etag string) (bool, error) {
	uploadStatus := "completed"
	// ASR only ever applies to video/audio. Every other file is marked
	// not_supported up front so the UI does not wait forever on a pending
	// badge that will never resolve.
	asrStatus := ASRStatusForMime(meta.MimeType)
	vectorStatus := "pending"
	now := time.Now()
	row := &model.CloudFile{
		UploadUUID:   uploadUUID,
		UID:          meta.UID,
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
	created, err := s.files.CreateIfAbsentAndBump(s.db, row)
	if err != nil {
		slog.Error("[CLOUD_UPLOAD] DB settlement failed",
			"upload_uuid", uploadUUID, "uid", meta.UID, "err", err)
		metrics.UploadComplete.WithLabelValues("db_error").Inc()
		return false, err
	}
	_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
	// Settlement succeeded: cancel the watchdog so its expiry event is never
	// emitted (complete AND MinIO-webhook paths both land here).
	s.CancelUploadDeadline(ctx, meta.UID, uploadUUID)
	s.pending.Remove(ctx, meta.UID, uploadUUID)
	return created, nil
}

// FinalizeFromEvent settles an upload from a MinIO bucket-notification event
// (s3:ObjectCreated:CompleteMultipartUpload). This is the safety net for the
// window where the client never calls complete (crash/offline) or where MinIO
// completed but the DB write failed. Idempotent: duplicates and the client
// complete path converge on the same row/quota bump. Objects whose Redis
// session is already gone are left for the orphan reconciler.
func (s *UploadService) FinalizeFromEvent(ctx context.Context, objectKey, eventETag string) error {
	uid, uploadUUID, ok := ParseUploadObjectKey(objectKey)
	if !ok {
		return nil // not a cloud-upload object (other bucket traffic)
	}
	// Fast idempotency check: already settled by the client complete path.
	if exists, err := s.files.ExistsByUploadUUID(s.db, uploadUUID); err != nil {
		return err
	} else if exists {
		s.CancelUploadDeadline(ctx, uid, uploadUUID)
		metrics.UploadComplete.WithLabelValues("event_duplicate").Inc()
		return nil
	}

	raw, err := s.rdb.Get(ctx, uploadKeyPrefix+uploadUUID).Result()
	if err != nil {
		slog.Warn("[CLOUD_EVENT] orphan object: upload session gone (left for reconciler)",
			"object_key", objectKey, "uid", uid, "upload_uuid", uploadUUID)
		metrics.UploadComplete.WithLabelValues("event_orphan").Inc()
		return nil
	}
	var meta uploadMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		slog.Warn("[CLOUD_EVENT] corrupt upload session — skipping", "upload_uuid", uploadUUID, "err", err)
		metrics.UploadComplete.WithLabelValues("event_corrupt").Inc()
		return nil
	}
	if meta.UID != uid || meta.ObjectKey != objectKey {
		slog.Warn("[CLOUD_EVENT] event/session mismatch — skipping",
			"upload_uuid", uploadUUID, "event_uid", uid, "session_uid", meta.UID,
			"event_key", objectKey, "session_key", meta.ObjectKey)
		metrics.UploadComplete.WithLabelValues("event_mismatch").Inc()
		return nil
	}

	actualSize, serr := s.minio.ObjectSize(ctx, objectKey)
	if serr != nil {
		return serr // transient: let MinIO retry the webhook
	}
	if actualSize != meta.FileSize {
		slog.Error("[CLOUD_EVENT] size mismatch — rejecting upload and removing object",
			"upload_uuid", uploadUUID, "declared", meta.FileSize, "actual", actualSize)
		_ = s.minio.DeleteObject(ctx, objectKey)
		_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
		s.pending.Remove(ctx, uid, uploadUUID)
		metrics.UploadComplete.WithLabelValues("event_size_mismatch").Inc()
		return nil
	}

	created, err := s.finalizeUpload(ctx, uploadUUID, meta, eventETag)
	if err != nil {
		return err
	}
	if created {
		slog.Info("[CLOUD_EVENT] settled upload from MinIO event",
			"upload_uuid", uploadUUID, "uid", uid, "object_key", objectKey)
		metrics.UploadComplete.WithLabelValues("event_ok").Inc()
	} else {
		metrics.UploadComplete.WithLabelValues("event_duplicate").Inc()
	}
	return nil
}

// ScheduleUploadDeadline registers/refreshes this upload's deadline in the
// sharded ZSET queue (score = unix ms). Called on init and renewed on
// heartbeat/resume; settlement calls CancelUploadDeadline.
func (s *UploadService) ScheduleUploadDeadline(ctx context.Context, uid int64, uploadUUID string, deadline time.Time) {
	if s.rdb == nil {
		return
	}
	member := deadlineMember(uid, uploadUUID)
	key := uploadDeadlineKey(uploadShard(uid))
	if err := s.rdb.ZAdd(ctx, key, redis.Z{
		Score:  float64(deadline.UnixMilli()),
		Member: member,
	}).Err(); err != nil {
		slog.Warn("[CLOUD_UPLOAD] deadline schedule failed",
			"upload_uuid", uploadUUID, "err", err)
	}
}

// CancelUploadDeadline removes the upload from the deadline + processing
// queues (settlement succeeded — complete or MinIO webhook, both paths).
func (s *UploadService) CancelUploadDeadline(ctx context.Context, uid int64, uploadUUID string) {
	if s.rdb == nil {
		return
	}
	member := deadlineMember(uid, uploadUUID)
	shard := uploadShard(uid)
	_ = s.rdb.ZRem(ctx, uploadDeadlineKey(shard), member).Err()
	_ = s.rdb.ZRem(ctx, uploadProcessingKey(shard), member).Err()
}

// claimDeadlineScript atomically moves due members from deadline -> processing
// with a visibility timeout (KEYS: deadline, processing; ARGV: now_ms, batch,
// visibility_until_ms). Multiple replicas may sweep concurrently: the Lua
// script is the single-winner claim, so no member is handled twice.
var claimDeadlineScript = redis.NewScript(
	"local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])\n" +
		"for i, m in ipairs(due) do\n" +
		"  redis.call('ZREM', KEYS[1], m)\n" +
		"  redis.call('ZADD', KEYS[2], ARGV[3], m)\n" +
		"end\n" +
		"return due")

// requeueStaleScript puts members stuck in processing past their visibility
// timeout back into the deadline queue (crash recovery, ARGV: now_ms, batch).
var requeueStaleScript = redis.NewScript(
	"local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])\n" +
		"for i, m in ipairs(stale) do\n" +
		"  redis.call('ZREM', KEYS[2], m)\n" +
		"  redis.call('ZADD', KEYS[1], ARGV[1], m)\n" +
		"end\n" +
		"return stale")

// RunDeadlineSweeper periodically claims due upload deadlines and reconciles
// MinIO vs DB for each upload (see HandleWatchdogExpired). Durable (AOF),
// sharded (64 ZSETs), batch-claimed and retried via the processing set — this
// replaces the old TTL-key + keyspace-pub/sub watchdog.
func RunDeadlineSweeper(ctx context.Context, cfg *config.Config, rdb redis.UniversalClient, svc *UploadService) {
	if rdb == nil || svc == nil {
		slog.Warn("[UPLOAD_SWEEPER] disabled (redis or upload service unavailable)")
		return
	}
	interval := time.Duration(cfg.Upload.SweepIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	batch := cfg.Upload.SweepBatch
	if batch <= 0 {
		batch = 200
	}
	visibility := time.Duration(cfg.Upload.SweepVisibilitySeconds) * time.Second
	if visibility <= 0 {
		visibility = time.Minute
	}
	slog.Info("[UPLOAD_SWEEPER] started",
		"interval", interval, "batch", batch, "visibility", visibility,
		"shards", uploadDeadlineShards)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			svc.sweepOnce(ctx, batch, visibility)
		}
	}
}

// sweepOnce processes one pass over all deadline shards: requeue stale claims,
// claim due members, clean each upload, then acknowledge (ZREM processing).
func (s *UploadService) sweepOnce(ctx context.Context, batch int, visibility time.Duration) {
	now := time.Now()
	nowMs := now.UnixMilli()
	visMs := now.Add(visibility).UnixMilli()
	var dueTotal int64
	for shard := 0; shard < uploadDeadlineShards; shard++ {
		dk := uploadDeadlineKey(shard)
		pk := uploadProcessingKey(shard)
		if _, err := requeueStaleScript.Run(ctx, s.rdb, []string{dk, pk}, nowMs, batch).Result(); err != nil {
			slog.Warn("[UPLOAD_SWEEPER] requeue stale failed", "shard", shard, "err", err)
			continue
		}
		res, err := claimDeadlineScript.Run(ctx, s.rdb, []string{dk, pk}, nowMs, batch, visMs).Result()
		if err != nil {
			slog.Warn("[UPLOAD_SWEEPER] claim failed", "shard", shard, "err", err)
			continue
		}
		members, _ := res.([]interface{})
		for _, raw := range members {
			member, ok := raw.(string)
			if !ok {
				continue
			}
			uid, uploadUUID, ok := ParseDeadlineMember(member)
			if !ok {
				_ = s.rdb.ZRem(ctx, pk, member).Err()
				continue
			}
			if err := s.HandleWatchdogExpired(ctx, uid, uploadUUID); err != nil {
				metrics.UploadSweep.WithLabelValues("error").Inc()
				slog.Warn("[UPLOAD_SWEEPER] cleanup failed (retry after visibility timeout)",
					"uid", uid, "upload_uuid", uploadUUID, "err", err)
				continue
			}
			_ = s.rdb.ZRem(ctx, pk, member).Err()
		}
		if n, err := s.rdb.ZCard(ctx, dk).Result(); err == nil {
			dueTotal += n
		}
	}
	metrics.UploadDeadlineDue.Set(float64(dueTotal))
}

// HandleWatchdogExpired reconciles MinIO vs DB for ONE upload whose deadline
// elapsed without settlement:
//   - DB row exists (late complete/webhook) -> clean session, no delete
//   - objects exist + no DB row             -> batch-delete them (A-type)
//   - no completed object (multipart only)  -> release session + reservation
//
// Objects modified within the recent-guard window are left alone and the
// upload is rescheduled, closing the complete-vs-expiry race.
func (s *UploadService) HandleWatchdogExpired(ctx context.Context, uid int64, uploadUUID string) error {
	if exists, err := s.files.ExistsByUploadUUID(s.db, uploadUUID); err != nil {
		return err
	} else if exists {
		_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
		metrics.UploadSweep.WithLabelValues("already_settled").Inc()
		slog.Info("[UPLOAD_SWEEPER] upload already settled, cleaned up",
			"uid", uid, "upload_uuid", uploadUUID)
		return nil
	}

	guard := s.sweepRecentGuard
	if guard <= 0 {
		guard = 5 * time.Minute
	}
	cutoff := time.Now().Add(-guard)
	prefix := fmt.Sprintf("%d/%s/", uid, uploadUUID)
	toDelete := make([]string, 0, 1)
	recent := false
	for obj := range s.minio.ListPrefix(ctx, prefix) {
		if !obj.LastModified.IsZero() && obj.LastModified.After(cutoff) {
			recent = true
			continue
		}
		toDelete = append(toDelete, obj.Key)
	}
	if recent {
		// The upload may still be finalising (complete just merged the object).
		// Postpone instead of deleting; the DB re-check above runs again then.
		s.ScheduleUploadDeadline(ctx, uid, uploadUUID, time.Now().Add(guard))
		metrics.UploadSweep.WithLabelValues("rescheduled").Inc()
		slog.Info("[UPLOAD_SWEEPER] recent object detected, cleanup postponed",
			"uid", uid, "upload_uuid", uploadUUID, "guard", guard)
		return nil
	}

	if len(toDelete) > 0 {
		if err := s.minio.RemoveObjects(ctx, toDelete); err != nil {
			return err
		}
		metrics.UploadSweep.WithLabelValues("deleted").Inc()
		metrics.UploadSweepObjectsDeleted.Add(float64(len(toDelete)))
		slog.Warn("[UPLOAD_SWEEPER] orphan objects deleted (MinIO has them, DB has no row)",
			"uid", uid, "upload_uuid", uploadUUID, "objects_deleted", len(toDelete))
	} else {
		metrics.UploadSweep.WithLabelValues("no_object").Inc()
		slog.Info("[UPLOAD_SWEEPER] expired upload had no completed object",
			"uid", uid, "upload_uuid", uploadUUID)
	}

	_ = s.rdb.Del(ctx, uploadKeyPrefix+uploadUUID).Err()
	s.pending.Remove(ctx, uid, uploadUUID)
	return nil
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
	// Keep the deadline alive while the client is actively uploading.
	s.ScheduleUploadDeadline(ctx, uid, hs.UploadUUID,
		time.Now().Add(time.Duration(uploadMetaTTL)*time.Second))
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
	s.ScheduleUploadDeadline(ctx, meta.UID, uploadUUID,
		time.Now().Add(time.Duration(uploadMetaTTL)*time.Second))
	slog.Info("[CLOUD_UPLOAD] resume_upload", "upload_uuid", uploadUUID, "chunks", len(pending))
	return &UploadResumeResult{
		UploadUUID:    uploadUUID,
		MinioUploadID: meta.MinioUploadID,
		PendingChunks: pending,
	}, nil
}
