package service

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// PendingUploads — in-flight upload accounting.
//
// Quota semantics: a chunked upload consumes quota progressively, but the
// cloud_files row only appears on complete. Without this ledger, N parallel
// uploads each pass the init check and together exceed the quota (race), and
// in-flight bytes are invisible in /cloud/quota. Each init registers
// fileSize in a per-uid Redis hash; complete (or abort) removes it.
//
// Crash/abandon safety: entries carry the init timestamp; entries older than
// uploadMetaTTL (the same window after which the upload session itself
// expires from Redis) are ignored in sums and opportunistically removed —
// mirroring the session lifecycle, so abandoned uploads never leak into the
// quota permanently.
type PendingUploads struct {
	rdb    redis.UniversalClient
	ttl    time.Duration
	prefix string
}

type pendingEntry struct {
	FileSize int64 `json:"file_size"`
	InitAt   int64 `json:"init_at"`
}

func NewPendingUploads(rdb redis.UniversalClient, metaTTL int) *PendingUploads {
	return &PendingUploads{
		rdb:    rdb,
		ttl:    time.Duration(metaTTL) * time.Second,
		prefix: "mind-base:cloud:pending:",
	}
}

func (p *PendingUploads) key(uid int64) string {
	return p.prefix + strconv.FormatInt(uid, 10)
}

// Add registers an in-flight upload's size.
func (p *PendingUploads) Add(ctx context.Context, uid int64, uploadUUID string, fileSize int64) {
	if p.rdb == nil {
		return
	}
	blob, _ := json.Marshal(pendingEntry{FileSize: fileSize, InitAt: time.Now().Unix()})
	p.rdb.HSet(ctx, p.key(uid), uploadUUID, string(blob))
}

// Remove unregisters an upload (complete / abort / failure paths). Idempotent.
func (p *PendingUploads) Remove(ctx context.Context, uid int64, uploadUUID string) {
	if p.rdb == nil {
		return
	}
	p.rdb.HDel(ctx, p.key(uid), uploadUUID)
}

// Sum returns the total in-flight bytes for a user, ignoring (and pruning)
// entries whose init timestamp is older than the upload session TTL.
func (p *PendingUploads) Sum(ctx context.Context, uid int64) int64 {
	if p.rdb == nil {
		return 0
	}
	values, err := p.rdb.HGetAll(ctx, p.key(uid)).Result()
	if err != nil || len(values) == 0 {
		return 0
	}
	cutoff := time.Now().Add(-p.ttl).Unix()
	total := int64(0)
	var stale []string
	for field, raw := range values {
		var e pendingEntry
		if json.Unmarshal([]byte(raw), &e) != nil {
			stale = append(stale, field)
			continue
		}
		if e.InitAt < cutoff {
			stale = append(stale, field)
			continue
		}
		total += e.FileSize
	}
	if len(stale) > 0 {
		p.rdb.HDel(ctx, p.key(uid), stale...)
	}
	return total
}
