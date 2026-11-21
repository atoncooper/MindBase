package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/minio"
	"app-cloud/internal/repo"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// HLS packaging is an async, multi-replica-safe worker over a Redis queue.
//
// Reliability model:
//   - enqueue is deduplicated per upload_uuid (SET NX marker + status check);
//   - the worker consumes with BLMOVE queue -> processing, so a crash leaves
//     the job recoverable instead of losing it;
//   - a per-upload lease (SET NX EX) guarantees at most one worker packages a
//     given video even when replicas run the same job;
//   - transient failures are retried with bounded exponential backoff, and a
//     janitor re-queues jobs whose owner died.
//
// Output is versioned (hls/{uid}/{uuid}/{version}/): a re-run writes a brand
// new prefix and only flips the status after every object is uploaded, so an
// in-flight playback never observes a half-written playlist. Older versions
// are garbage-collected only after the short-lived playback tokens expire.

// HLSService packages uploaded videos into HLS with ffmpeg and issues the
// short-lived edge token used by OpenResty. Video bytes never flow through
// this service: OpenResty proxies the HLS prefix from MinIO.
type HLSService struct {
	cfg   *config.Config
	db    *gorm.DB
	files *repo.FileRepo
	minio *minio.Client
	rdb   redis.UniversalClient
}

// NewHLSService wires the asynchronous HLS packager. A nil Redis client means
// HLS is disabled (the MP4 fallback remains available).
func NewHLSService(cfg *config.Config, db *gorm.DB, files *repo.FileRepo, mc *minio.Client, rdb redis.UniversalClient) *HLSService {
	return &HLSService{cfg: cfg, db: db, files: files, minio: mc, rdb: rdb}
}

func (s *HLSService) Enabled() bool {
	return s != nil && s.cfg.HLS.Enabled && s.rdb != nil && s.minio != nil && s.db != nil
}

// Start ensures the HLS prefix is edge-readable and launches workers plus the
// retry promoter / crash-recovery janitor.
func (s *HLSService) Start(ctx context.Context) {
	if !s.Enabled() {
		slog.Info("[HLS] disabled (set hls.enabled in default.yaml and Redis to enable)")
		return
	}
	if err := s.minio.EnsurePublicPrefix(ctx, s.cfg.HLS.Prefix, s.cfg.HLS.AllowedSourceCIDRs); err != nil {
		slog.Warn("[HLS] could not set public prefix policy; playback may be 403", "err", err)
	} else {
		slog.Info("[HLS] worker started", "workers", s.cfg.HLS.Workers, "prefix", s.cfg.HLS.Prefix,
			"max_attempts", s.maxAttempts())
	}
	for i := 0; i < s.cfg.HLS.Workers; i++ {
		go s.worker(ctx)
	}
	go s.retryPromoter(ctx)
	go s.janitor(ctx)
}

func (s *HLSService) basePrefix(uid int64, uploadUUID string) string {
	return strings.Trim(s.cfg.HLS.Prefix, "/") + "/" + strconv.FormatInt(uid, 10) + "/" + uploadUUID
}

func (s *HLSService) objectPrefix(uid int64, uploadUUID, version string) string {
	return s.basePrefix(uid, uploadUUID) + "/" + version
}

func hlsPathPrefix(uid int64, uploadUUID, version string) string {
	if version == "" {
		// Legacy unversioned output (pre-versioning deployments).
		return "/hls/" + strconv.FormatInt(uid, 10) + "/" + uploadUUID + "/"
	}
	return "/hls/" + strconv.FormatInt(uid, 10) + "/" + uploadUUID + "/" + version + "/"
}

func jobMember(job hlsJob) string {
	body, _ := json.Marshal(job)
	return string(body)
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
