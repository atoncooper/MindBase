package tests

// HLS queue/state guards that need a real Redis command surface. miniredis
// gives us the same Redis semantics without a server, so the reliability
// invariants (dedupe, ready-skip, token revocation) are exercised in CI.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/minio"
	"app-cloud/internal/service"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

func newHLSForTest(t *testing.T) (*service.HLSService, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	cfg := &config.Config{HLS: config.HLSConfig{
		Enabled:         true,
		Prefix:          "hls",
		MaxAttempts:     3,
		TokenTTLSeconds: 3600,
		TimeoutSeconds:  600,
	}}
	// Enqueue/RevokeTokens do not touch the DB or MinIO; non-nil placeholders
	// satisfy Enabled() without opening connections.
	svc := service.NewHLSService(cfg, &gorm.DB{}, nil, &minio.Client{}, rdb)
	return svc, mr, rdb
}

func TestHLSEnqueueIsIdempotentPerUpload(t *testing.T) {
	svc, _, rdb := newHLSForTest(t)
	ctx := context.Background()

	svc.Enqueue(ctx, 42, "uuid-1")
	svc.Enqueue(ctx, 42, "uuid-1") // client complete + MinIO event race

	if n := rdb.LLen(ctx, "cloud:hls:queue").Val(); n != 1 {
		t.Fatalf("queue length = %d, want 1 (duplicate enqueue must collapse)", n)
	}
	status, err := rdb.Get(ctx, "cloud:hls:status:uuid-1").Result()
	if err != nil {
		t.Fatalf("status missing: %v", err)
	}
	if !strings.Contains(status, "queued") {
		t.Fatalf("status = %s, want queued", status)
	}

	// A worker popping the job must not let a third event enqueue it again
	// while the job is still outstanding.
	if _, err := rdb.LPop(ctx, "cloud:hls:queue").Result(); err != nil {
		t.Fatalf("lpop: %v", err)
	}
	svc.Enqueue(ctx, 42, "uuid-1")
	if n := rdb.LLen(ctx, "cloud:hls:queue").Val(); n != 0 {
		t.Fatalf("queue length = %d, want 0 while job is already owned", n)
	}
}

func TestHLSEnqueueSkipsReadyOutput(t *testing.T) {
	svc, _, rdb := newHLSForTest(t)
	ctx := context.Background()
	ready := "{\"status\":\"ready\",\"prefix\":\"hls/7/uuid-2/vabc\",\"version\":\"vabc\",\"playlist\":\"master.m3u8\",\"progress\":100,\"updatedAt\":1}"
	if err := rdb.Set(ctx, "cloud:hls:status:uuid-2", ready, time.Hour).Err(); err != nil {
		t.Fatalf("seed status: %v", err)
	}

	svc.Enqueue(ctx, 7, "uuid-2") // late duplicate bucket notification
	if n := rdb.LLen(ctx, "cloud:hls:queue").Val(); n != 0 {
		t.Fatalf("queue length = %d, want 0 (ready output must not be re-encoded)", n)
	}
}

func TestHLSEnqueueJobPayloadShape(t *testing.T) {
	svc, _, rdb := newHLSForTest(t)
	ctx := context.Background()
	svc.Enqueue(ctx, 9, "uuid-3")
	raw, err := rdb.LIndex(ctx, "cloud:hls:queue", 0).Result()
	if err != nil {
		t.Fatalf("lindex: %v", err)
	}
	var job map[string]any
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		t.Fatalf("job json: %v", err)
	}
	if job["uid"] != float64(9) || job["uploadUuid"] != "uuid-3" {
		t.Fatalf("job = %+v", job)
	}
}

func TestHLSRevokeTokensRemovesCapabilities(t *testing.T) {
	svc, _, rdb := newHLSForTest(t)
	ctx := context.Background()
	if err := rdb.Set(ctx, "cloud:hls:token:tok-1", "{}", time.Hour).Err(); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	if err := rdb.SAdd(ctx, "cloud:hls:tokset:uuid-4", "tok-1").Err(); err != nil {
		t.Fatalf("seed token set: %v", err)
	}

	svc.RevokeTokens(ctx, "uuid-4")

	if n := rdb.Exists(ctx, "cloud:hls:token:tok-1").Val(); n != 0 {
		t.Fatalf("token survived revocation")
	}
	if n := rdb.Exists(ctx, "cloud:hls:tokset:uuid-4").Val(); n != 0 {
		t.Fatalf("token set survived revocation")
	}
}
