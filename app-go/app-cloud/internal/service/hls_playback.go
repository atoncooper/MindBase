package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/metrics"

	"github.com/redis/go-redis/v9"
)

// Playback verifies ownership/readiness and mints a short-lived edge capability.
// Two cookies are issued: hls_token (Redis-backed token) and hls_ctx (session
// binding). OpenResty requires both on every playlist/segment request, so a
// token copied out of logs or browser storage is not replayable without the
// matching cookie jar.
func (s *HLSService) Playback(ctx context.Context, uid int64, uploadUUID, bind string) (HLSPlayback, string, error) {
	if !s.Enabled() {
		return HLSPlayback{Ready: false, Status: "disabled"}, "", nil
	}
	file, err := s.files.GetByUUID(s.db, uploadUUID, uid)
	if err != nil {
		return HLSPlayback{}, "", err
	}
	if file == nil || !strings.HasPrefix(strings.ToLower(file.MimeType), "video/") {
		return HLSPlayback{Ready: false, Status: "unsupported"}, "", nil
	}

	status, err := s.getStatus(ctx, uploadUUID)
	if err != nil {
		return HLSPlayback{Ready: false, Status: hlsStateProcessing}, "", nil
	}
	if status.Status != hlsStateReady || status.Prefix == "" {
		st := status.Status
		if st == "" {
			st = hlsStateProcessing
		}
		progress := status.Progress
		if progress == 0 && st == hlsStateProcessing {
			progress = hlsProgressDownload
		}
		return HLSPlayback{
			Ready:     false,
			Status:    st,
			Progress:  progress,
			Attempts:  status.Attempts,
			Retryable: status.Retryable,
		}, "", nil
	}

	if len(bind) < 8 || len(bind) > 128 {
		// Missing/oversized client binding: mint a fresh one so the caller can
		// persist it as the hls_ctx cookie.
		fresh, genErr := randomToken()
		if genErr != nil {
			return HLSPlayback{}, "", genErr
		}
		bind = fresh
	}
	token, err := randomToken()
	if err != nil {
		return HLSPlayback{}, "", err
	}
	ttl := s.cfg.HLS.TokenTTLSeconds
	// Legacy statuses (written before output versioning) have no Version; keep
	// them playable until their next re-package.
	path := hlsPathPrefix(uid, uploadUUID, status.Version)
	entry := status.Playlist
	if entry == "" {
		entry = hlsPlaylistKey
	}
	poster := ""
	if status.Cover != "" {
		poster = path + status.Cover
	}
	payload := hlsTokenPayload{
		UID:    uid,
		UUID:   uploadUUID,
		Bucket: s.minio.Bucket(),
		Prefix: status.Prefix,
		Path:   path,
		Bind:   bind,
		Exp:    time.Now().Add(time.Duration(ttl) * time.Second).Unix(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return HLSPlayback{}, "", err
	}
	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, hlsTokenPfx+token, body, time.Duration(ttl)*time.Second)
	pipe.SAdd(ctx, hlsTokenSetPfx+uploadUUID, token)
	pipe.Expire(ctx, hlsTokenSetPfx+uploadUUID, time.Duration(ttl)*time.Second+time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		return HLSPlayback{}, "", err
	}
	metrics.HLSTokensMinted.Inc()
	// Playback audit: who got a capability, for which immutable version, how long.
	slog.Info("[HLS] token minted", "uid", uid, "upload_uuid", uploadUUID,
		"version", status.Version, "playlist", entry, "ttl", ttl)
	return HLSPlayback{
		Ready:       true,
		Status:      hlsStateReady,
		PlaylistURL: path + entry,
		PosterURL:   poster,
		ExpiresIn:   ttl,
	}, token, nil
}

// NewBindValue returns a fresh opaque session-binding value for the hls_ctx
// cookie (stable per browser; tokens embed it so a copied token is useless).
func (s *HLSService) NewBindValue() (string, error) { return randomToken() }

// RevokeTokens invalidates every playback token minted for a file. Called when
// a file is trashed so a still-valid cookie cannot keep streaming it.
func (s *HLSService) RevokeTokens(ctx context.Context, uploadUUID string) {
	if s == nil || s.rdb == nil || uploadUUID == "" {
		return
	}
	setKey := hlsTokenSetPfx + uploadUUID
	tokens, err := s.rdb.SMembers(ctx, setKey).Result()
	if err != nil && err != redis.Nil {
		slog.Warn("[HLS] token set read failed", "upload_uuid", uploadUUID, "err", err)
		return
	}
	if len(tokens) > 0 {
		keys := make([]string, 0, len(tokens)+1)
		for _, t := range tokens {
			keys = append(keys, hlsTokenPfx+t)
		}
		keys = append(keys, setKey)
		if err := s.rdb.Del(ctx, keys...).Err(); err != nil {
			slog.Warn("[HLS] token revoke failed", "upload_uuid", uploadUUID, "err", err)
		}
	} else {
		_ = s.rdb.Del(ctx, setKey).Err()
	}
}

// DeleteAssets removes every derived object and all Redis state for a purged
// file: versioned playlists/segments, status, retry/queue entries and tokens.
// It also leaves a short-lived tombstone so a worker that already downloaded
// the source cannot re-upload objects after the purge.
func (s *HLSService) DeleteAssets(ctx context.Context, uid int64, uploadUUID string) {
	if s == nil || s.rdb == nil || uploadUUID == "" {
		return
	}
	_ = s.rdb.Set(ctx, hlsGonePfx+uploadUUID, "1", hlsGoneTTL).Err()

	base := s.basePrefix(uid, uploadUUID)
	keys := make([]string, 0, 64)
	for obj := range s.minio.ListPrefix(ctx, base+"/") {
		keys = append(keys, obj.Key)
		if len(keys) >= 5000 {
			break
		}
	}
	if len(keys) > 0 {
		if err := s.minio.RemoveObjects(ctx, keys); err != nil {
			slog.Warn("[HLS] asset delete failed", "upload_uuid", uploadUUID, "objects", len(keys), "err", err)
		}
	}

	body := jobMember(hlsJob{UID: uid, UploadUUID: uploadUUID})
	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, hlsStatusPfx+uploadUUID, hlsAttemptsPfx+uploadUUID,
		hlsJobKeyPfx+uploadUUID, hlsLeasePfx+uploadUUID)
	pipe.ZRem(ctx, hlsRetryKey, body)
	pipe.LRem(ctx, hlsQueueKey, 0, body)
	_, _ = pipe.Exec(ctx)
	s.RevokeTokens(ctx, uploadUUID)
	slog.Info("[HLS] assets deleted", "upload_uuid", uploadUUID, "objects", len(keys))
}

// ── worker ───────────────────────────────────────────────────────────
