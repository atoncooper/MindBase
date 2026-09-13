package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"app-board/internal/cache"
	"app-board/internal/model"
	"app-board/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// ── in-memory doc store implementing repo.DocStore ──────────────────

type memDocs struct {
	mu    sync.Mutex
	docs  map[string]*repo.BoardDocument
	nextN int // forced failures for storage-error paths (0 = none)
}

func newMemDocs() *memDocs { return &memDocs{docs: map[string]*repo.BoardDocument{}} }

func (m *memDocs) ConditionalWrite(_ context.Context, uuid string, expected int64, content string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nextN > 0 {
		m.nextN--
		return errors.New("forced storage failure")
	}
	cur, ok := m.docs[uuid]
	if ok && cur.Version != expected {
		return repo.ErrConflict
	}
	// Absent doc -> insert (heal path), mirroring Mongo ReplaceOne upsert:
	// the replacement doc is stored verbatim with version expected+1.
	m.docs[uuid] = &repo.BoardDocument{BoardUUID: uuid, Version: expected + 1, Content: content}
	return nil
}

func (m *memDocs) Get(_ context.Context, uuid string) (*repo.BoardDocument, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.docs[uuid]; ok {
		cp := *d
		return &cp, nil
	}
	return nil, nil
}

func (m *memDocs) Restore(_ context.Context, uuid string, writtenVersion int64, prior *repo.BoardDocument) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if prior == nil {
		if d, ok := m.docs[uuid]; ok && d.Version == writtenVersion {
			delete(m.docs, uuid)
		}
		return nil
	}
	if d, ok := m.docs[uuid]; ok && d.Version == writtenVersion {
		cp := *prior
		m.docs[uuid] = &cp
	}
	return nil
}

// ── sqlite meta store (real repo.BoardRepo against glebarez/sqlite) ─

func newMeta(t *testing.T) *repo.BoardRepo {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := g.AutoMigrate(&model.Board{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &repo.BoardRepo{DB: g}
}

const uid int64 = 42

func TestCreateAndGet(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, err := svc.Create(context.Background(), uid, "导图一", KindMindmap, `{"data":"v1"}`)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if meta.Version != 1 {
		t.Fatalf("version = %d, want 1", meta.Version)
	}
	detail, err := svc.GetDetail(context.Background(), uid, meta.UUID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if detail.Content == nil || *detail.Content != `{"data":"v1"}` {
		t.Fatalf("content = %v", detail.Content)
	}
}

func TestCreateInvalidKind(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	if _, err := svc.Create(context.Background(), uid, "x", "neon4j", ""); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestUpdateHappyPath(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "t", KindMindmap, "")
	title := "new title"
	updated, err := svc.Update(context.Background(), uid, meta.UUID, meta.Version,
		UpdateParams{Content: strPtr(`{"v":2}`), Title: &title})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != meta.Version+1 {
		t.Fatalf("version = %d, want %d", updated.Version, meta.Version+1)
	}
	detail, _ := svc.GetDetail(context.Background(), uid, meta.UUID)
	if detail.Title != "new title" || detail.Content == nil || *detail.Content != `{"v":2}` {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestUpdateMissingIfMatchIs428(t *testing.T) {
	// Update() itself requires a parsed ifMatch; the router enforces 428.
	// Here: passing a sentinel mismatched value must yield 409 semantics.
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "t", KindMindmap, "")
	_, err := svc.Update(context.Background(), uid, meta.UUID, meta.Version+5,
		UpdateParams{Content: strPtr("{}")})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

func TestConcurrentUpdateLoser409AndNoClobber(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "t", KindMindmap, `{"v":0}`)

	// Both writers read version 1.
	winner, err := svc.Update(context.Background(), uid, meta.UUID, 1, UpdateParams{Content: strPtr(`{"winner":true}`)})
	if err != nil {
		t.Fatalf("winner: %v", err)
	}
	_, err = svc.Update(context.Background(), uid, meta.UUID, 1, UpdateParams{Content: strPtr(`{"loser":true}`)})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("loser err = %v, want ErrConflict", err)
	}
	detail, _ := svc.GetDetail(context.Background(), uid, meta.UUID)
	if detail.Content == nil || *detail.Content != `{"winner":true}` {
		t.Fatalf("body clobbered: %v", detail.Content)
	}
	if detail.Version != winner.Version {
		t.Fatalf("version skew: meta %d vs winner %d", detail.Version, winner.Version)
	}
}

func TestStorageErrorRollsBackBody(t *testing.T) {
	docs := newMemDocs()
	svc := NewBoardService(newMeta(t), docs, cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "t", KindMindmap, `{"v":0}`)

	docs.mu.Lock()
	docs.nextN = 1 // next ConditionalWrite (body write inside Update) fails
	docs.mu.Unlock()

	_, err := svc.Update(context.Background(), uid, meta.UUID, meta.Version, UpdateParams{Content: strPtr(`{"new":1}`)})
	if !errors.Is(err, ErrStorage) {
		t.Fatalf("err = %v, want ErrStorage", err)
	}
	detail, _ := svc.GetDetail(context.Background(), uid, meta.UUID)
	if detail.Content == nil || *detail.Content != `{"v":0}` {
		t.Fatalf("body changed after failed update: %v", detail.Content)
	}
}

func TestRollbackOnLostMetaRace(t *testing.T) {
	// Simulate: Mongo write wins, but MySQL bump finds 0 rows (another
	// writer bumped metadata in between). Service must roll back the body
	// and return 409.
	docs := newMemDocs()
	meta := newMeta(t)
	svc := NewBoardService(meta, docs, cache.NewInMemory())
	created, _ := svc.Create(context.Background(), uid, "t", KindMindmap, `{"v":0}`)

	// Another writer advances metadata behind our back.
	if _, err := meta.BumpVersion(context.Background(), uid, created.UUID, 1, nil, nil); err != nil {
		t.Fatalf("background bump: %v", err)
	}

	// Our writer still believes version=1; memDocs doc version is 1 too, so
	// the Mongo conditional write succeeds — then the meta bump must fail.
	_, err := svc.Update(context.Background(), uid, created.UUID, 1, UpdateParams{Content: strPtr(`{"sneaky":1}`)})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	detail, _ := svc.GetDetail(context.Background(), uid, created.UUID)
	if detail.Content == nil || *detail.Content != `{"v":0}` {
		t.Fatalf("rollback failed, body = %v", detail.Content)
	}
}

func TestOwnershipIsolation(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "mine", KindMindmap, "")
	if _, err := svc.GetDetail(context.Background(), uid+1, meta.UUID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if err := svc.Delete(context.Background(), uid+1, meta.UUID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := svc.GetDetail(context.Background(), uid, meta.UUID); err != nil {
		t.Fatalf("owner lost access: %v", err)
	}
}

func TestSoftDeleteHidesBoard(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	meta, _ := svc.Create(context.Background(), uid, "gone", KindMindmap, "")
	if err := svc.Delete(context.Background(), uid, meta.UUID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := svc.GetDetail(context.Background(), uid, meta.UUID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	boards, total, _ := svc.ListMetas(context.Background(), uid, "", 1, 20)
	if total != 0 || len(boards) != 0 {
		t.Fatalf("soft-deleted board still listed: total=%d", total)
	}
}

func TestListPaginationAndPin(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	ctx := context.Background()
	a, _ := svc.Create(ctx, uid, "a", KindMindmap, "")
	b, _ := svc.Create(ctx, uid, "b", KindMindmap, "")
	svc.Create(ctx, uid, "c", KindWhiteboard, "")

	// Touch b so it is strictly the most recent. On Windows time.Now()
	// resolution (~0.5ms) can make back-to-back writes share a timestamp,
	// so give the clock a moment to advance first.
	time.Sleep(20 * time.Millisecond)
	if _, err := svc.Update(ctx, uid, b.UUID, b.Version, UpdateParams{Content: strPtr(`{}`)}); err != nil {
		t.Fatalf("touch b: %v", err)
	}

	if _, err := svc.SetPin(ctx, uid, a.UUID, true); err != nil {
		t.Fatalf("pin: %v", err)
	}
	boards, total, _ := svc.ListMetas(ctx, uid, "", 1, 20)
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	if boards[0].UUID != a.UUID || !boards[0].IsPinned {
		t.Fatalf("pinned board not first: %+v", boards[0])
	}
	if boards[1].UUID != b.UUID {
		t.Fatalf("most recent not second: %+v", boards[1])
	}
	wb, _, _ := svc.ListMetas(ctx, uid, KindWhiteboard, 1, 20)
	if len(wb) != 1 || wb[0].Title != "c" {
		t.Fatalf("kind filter broken: %+v", wb)
	}
}

func TestContentTooBig(t *testing.T) {
	svc := NewBoardService(newMeta(t), newMemDocs(), cache.NewInMemory())
	big := make([]byte, MaxContentBytes+1)
	_, err := svc.Update(context.Background(), uid, "nope", 1, UpdateParams{Content: strPtr(string(big))})
	if !errors.Is(err, ErrContentTooBig) {
		t.Fatalf("err = %v, want ErrContentTooBig", err)
	}
}

func strPtr(s string) *string { return &s }
