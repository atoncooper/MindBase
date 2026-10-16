package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// reserveScript atomically does what the old Sum → check → Add sequence did
// in three round-trips: (a) prunes stale pending entries past the session
// window, (b) checks used (MySQL snapshot) + pending + fileSize against the
// quota, (c) registers the reservation. Redis serializes scripts, so N
// parallel upload inits can no longer each pass the check and together
// overshoot the quota (the race the ledger was built to prevent but only
// narrowed — the atomic script closes it).
//
// ARGV: 1=uploadUUID 2=fileSize 3=quota 4=used 5=staleCutoff 6=now
// Returns {ok(0|1), pendingTotalAfter}.
var reserveScript = `
local total = 0
local stale = {}
local entries = redis.call('HGETALL', KEYS[1])
for i = 1, #entries, 2 do
	local field, raw = entries[i], entries[i + 1]
	local ok, e = pcall(cjson.decode, raw)
	if not ok or e == nil or tonumber(e['file_size']) == nil
		or tonumber(e['init_at']) == nil or tonumber(e['init_at']) < tonumber(ARGV[5]) then
		stale[#stale + 1] = field
	else
		total = total + tonumber(e['file_size'])
	end
end
if #stale > 0 then
	redis.call('HDEL', KEYS[1], unpack(stale))
end
if tonumber(ARGV[4]) + total + tonumber(ARGV[2]) > tonumber(ARGV[3]) then
	return {0, total}
end
redis.call('HSET', KEYS[1], ARGV[1],
	cjson.encode({file_size = tonumber(ARGV[2]), init_at = tonumber(ARGV[6])}))
return {1, total + tonumber(ARGV[2])}
`

// Reserve runs the atomic check-and-reserve. Returns (false, pendingTotal)
// when the quota would be exceeded; err only on Redis failure — the caller
// decides the degradation (QuotaService falls back to the legacy check).
func (p *PendingUploads) Reserve(ctx context.Context, uid int64, uploadUUID string,
	fileSize, quota, used int64) (bool, int64, error) {
	if p.rdb == nil {
		return true, 0, errors.New("redis unavailable — reservation not possible")
	}
	now := time.Now().Unix()
	cutoff := now - int64(p.ttl.Seconds())
	res, err := p.rdb.Eval(ctx, reserveScript, []string{p.key(uid)},
		uploadUUID, fileSize, quota, used, cutoff, now).Result()
	if err != nil {
		return false, 0, err
	}
	arr, ok := res.([]interface{})
	if !ok || len(arr) != 2 {
		return false, 0, fmt.Errorf("unexpected reserve result: %v", res)
	}
	flag, _ := arr[0].(int64)
	total, _ := arr[1].(int64)
	return flag == 1, total, nil
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
