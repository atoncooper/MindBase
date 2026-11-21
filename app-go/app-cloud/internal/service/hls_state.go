package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

func (s *HLSService) setStatus(ctx context.Context, uploadUUID string, status hlsStatus) {
	if s.rdb == nil || uploadUUID == "" {
		return
	}
	status.UpdatedAt = time.Now().Unix()
	body, err := json.Marshal(status)
	if err != nil {
		return
	}
	_ = s.rdb.Set(ctx, hlsStatusPfx+uploadUUID, body, hlsStatusTTL).Err()
}

func (s *HLSService) getStatus(ctx context.Context, uploadUUID string) (hlsStatus, error) {
	var status hlsStatus
	if s.rdb == nil {
		return status, nil
	}
	body, err := s.rdb.Get(ctx, hlsStatusPfx+uploadUUID).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return status, nil
		}
		return status, err
	}
	err = json.Unmarshal([]byte(body), &status)
	return status, err
}

func (s *HLSService) isGone(ctx context.Context, uploadUUID string) bool {
	n, err := s.rdb.Exists(ctx, hlsGonePfx+uploadUUID).Result()
	return err == nil && n > 0
}

func (s *HLSService) scheduleGC(ctx context.Context, uid int64, uploadUUID, version string) {
	now := time.Now()
	ttl := time.Duration(s.cfg.HLS.TokenTTLSeconds) * time.Second
	body, err := json.Marshal(hlsGCEntry{UID: uid, UploadUUID: uploadUUID, Version: version, PublishedAt: now.Unix()})
	if err != nil {
		return
	}
	pipe := s.rdb.Pipeline()
	pipe.ZAdd(ctx, hlsGCKey, redis.Z{Score: float64(now.Add(ttl + 10*time.Minute).Unix()), Member: string(body)})
	pipe.Expire(ctx, hlsGCKey, 30*24*time.Hour)
	_, _ = pipe.Exec(ctx)
}

// gcVersions deletes output version directories that are entirely older than
// the entry's published version. Objects newer than the entry (a later
// re-package) are never touched; a 5 minute skew guard keeps a MinIO clock
// running slightly ahead from making a "new" version look old.
func (s *HLSService) gcVersions(ctx context.Context, entry hlsGCEntry) error {
	if entry.UploadUUID == "" || entry.Version == "" {
		return nil
	}
	base := s.basePrefix(entry.UID, entry.UploadUUID) + "/"
	publishedAt := time.Unix(entry.PublishedAt, 0).Add(-5 * time.Minute)
	type listed struct {
		key string
		mod time.Time
	}
	groups := make(map[string][]listed)
	for obj := range s.minio.ListPrefix(ctx, base) {
		rel := strings.TrimPrefix(obj.Key, base)
		parts := strings.SplitN(rel, "/", 2)
		version := ""
		if len(parts) == 2 {
			version = parts[0]
		}
		groups[version] = append(groups[version], listed{key: obj.Key, mod: obj.LastModified})
	}
	for version, objs := range groups {
		if version == entry.Version || len(objs) == 0 {
			continue
		}
		keys := make([]string, 0, len(objs))
		safe := true
		for _, o := range objs {
			if o.mod.IsZero() || !o.mod.Before(publishedAt) {
				safe = false
				break
			}
			keys = append(keys, o.key)
		}
		if !safe {
			continue
		}
		if err := s.minio.RemoveObjects(ctx, keys); err != nil {
			slog.Warn("[HLS] old version cleanup failed", "upload_uuid", entry.UploadUUID, "version", version, "err", err)
			return err
		}
		slog.Info("[HLS] old version removed", "upload_uuid", entry.UploadUUID, "version", version, "objects", len(keys))
	}
	return nil
}

func (s *HLSService) deletePrefix(ctx context.Context, prefix string) {
	keys := make([]string, 0, 64)
	for obj := range s.minio.ListPrefix(ctx, prefix) {
		keys = append(keys, obj.Key)
		if len(keys) >= 5000 {
			break
		}
	}
	if len(keys) > 0 {
		if err := s.minio.RemoveObjects(ctx, keys); err != nil {
			slog.Warn("[HLS] prefix delete failed", "prefix", prefix, "err", err)
		}
	}
}

// ── failure handling, leases, queues ─────────────────────────────────
