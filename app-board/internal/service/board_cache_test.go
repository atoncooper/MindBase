package service

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"

	"app-board/internal/cache"
)

func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// recordingCache wraps a real InMemoryCache and records every mutation, so
// tests can assert invalidation happened without prod code exposing internals.
type recordingCache struct {
	inner cache.CacheStore
	mu    sync.Mutex
	sets  []string
	dels  []string
	prefx []string
}

func newRecordingCache() *recordingCache {
	return &recordingCache{inner: cache.NewInMemory()}
}

func (r *recordingCache) Get(ctx context.Context, key string) (string, bool) {
	return r.inner.Get(ctx, key)
}
func (r *recordingCache) Set(ctx context.Context, key, value string) {
	r.mu.Lock()
	r.sets = append(r.sets, key)
	r.mu.Unlock()
	r.inner.Set(ctx, key, value)
}
func (r *recordingCache) Del(ctx context.Context, keys ...string) {
	r.mu.Lock()
	r.dels = append(r.dels, keys...)
	r.mu.Unlock()
	r.inner.Del(ctx, keys...)
}
func (r *recordingCache) DelByPrefix(ctx context.Context, prefix string) {
	r.mu.Lock()
	r.prefx = append(r.prefx, prefix)
	r.mu.Unlock()
	r.inner.DelByPrefix(ctx, prefix)
}
func (r *recordingCache) sawSet(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.sets {
		if k == key {
			return true
		}
	}
	return false
}
func (r *recordingCache) sawDel(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.dels {
		if k == key {
			return true
		}
	}
	return false
}
func (r *recordingCache) sawDelPrefix(prefix string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.prefx {
		if k == prefix {
			return true
		}
	}
	return false
}

// First read populates the detail cache; second read is served from it.
func TestDetailCacheHit(t *testing.T) {
	rc := newRecordingCache()
	svc := NewBoardService(newMeta(t), newMemDocs(), rc)
	meta, _ := svc.Create(context.Background(), uid, "t", KindMindmap, `{"v":1}`)
	key := "board:detail:" + itoa(uid) + ":" + meta.UUID

	first, err := svc.GetDetail(context.Background(), uid, meta.UUID)
	if err != nil {
		t.Fatalf("first get: %v", err)
	}
	if !rc.sawSet(key) {
		t.Fatal("detail not cached after first read")
	}
	second, err := svc.GetDetail(context.Background(), uid, meta.UUID)
	if err != nil {
		t.Fatalf("cached get: %v", err)
	}
	if first.Content == nil || second.Content == nil || *first.Content != *second.Content {
		t.Fatal("cached detail diverges from store detail")
	}
}

// A committed write must invalidate the affected detail + list keys, and the
// next read must reflect the new content (never the stale cached one).
func TestWriteInvalidatesCache(t *testing.T) {
	rc := newRecordingCache()
	svc := NewBoardService(newMeta(t), newMemDocs(), rc)
	ctx := context.Background()
	meta, _ := svc.Create(ctx, uid, "t", KindMindmap, `{"v":1}`)
	detailKey := "board:detail:" + itoa(uid) + ":" + meta.UUID
	_, _ = svc.GetDetail(ctx, uid, meta.UUID)    // populate detail cache
	_, _, _ = svc.ListMetas(ctx, uid, "", 1, 20) // populate list cache

	if _, err := svc.Update(ctx, uid, meta.UUID, meta.Version,
		UpdateParams{Content: strPtr(`{"v":2}`)}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !rc.sawDel(detailKey) {
		t.Fatal("detail key not invalidated after update")
	}
	if !rc.sawDelPrefix("board:list:" + itoa(uid) + ":") {
		t.Fatal("user list pages not invalidated after update")
	}
	detail, _ := svc.GetDetail(ctx, uid, meta.UUID)
	if detail.Content == nil || *detail.Content != `{"v":2}` {
		t.Fatalf("stale content served after write: %v", detail.Content)
	}
}

// Ownership: another user must never hit this user's cached detail — the uid
// is part of the cache key, so the miss path re-enforces ownership in the
// store and returns 404.
func TestCacheKeyIsolatesUsers(t *testing.T) {
	rc := newRecordingCache()
	svc := NewBoardService(newMeta(t), newMemDocs(), rc)
	ctx := context.Background()
	meta, _ := svc.Create(ctx, uid, "mine", KindMindmap, `{"v":1}`)
	_, _ = svc.GetDetail(ctx, uid, meta.UUID) // owner populates cache

	if _, err := svc.GetDetail(ctx, uid+1, meta.UUID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user got %v, want ErrNotFound", err)
	}
}

// Create must invalidate the user's cached list pages (new board appears).
func TestCreateInvalidatesListCache(t *testing.T) {
	rc := newRecordingCache()
	svc := NewBoardService(newMeta(t), newMemDocs(), rc)
	ctx := context.Background()
	_, _, _ = svc.ListMetas(ctx, uid, "", 1, 20) // empty list cached

	if _, err := svc.Create(ctx, uid, "new", KindMindmap, ""); err != nil {
		t.Fatalf("create: %v", err)
	}
	if !rc.sawDelPrefix("board:list:" + itoa(uid) + ":") {
		t.Fatal("list cache not invalidated on create")
	}
	boards, total, _ := svc.ListMetas(ctx, uid, "", 1, 20)
	if total != 1 || len(boards) != 1 {
		t.Fatalf("created board not visible after cache invalidation: total=%d", total)
	}
}

// Cache disabled (nil -> NoopCache) must behave identically, reads hitting
// the stores every time.
func TestNoopCachePath(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), nil)
	meta, err := svc.Create(context.Background(), uid, "t", KindMindmap, `{"v":1}`)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := svc.GetDetail(context.Background(), uid, meta.UUID); err != nil {
		t.Fatalf("get: %v", err)
	}
}
