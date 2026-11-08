package tests

import (
	boardsvc "app-content/internal/service/board"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	boardcache "app-content/internal/infra/cache/board"
	boardmodel "app-content/internal/model/board"
	boardrepo "app-content/internal/repo/board"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// ── in-memory doc store implementing repo.DocStore ──────────────────

type boardMemDocs struct {
	mu    sync.Mutex
	docs  map[string]*boardrepo.BoardDocument
	nextN int // forced failures for storage-error paths (0 = none)
}

func newBoardMemDocs() *boardMemDocs {
	return &boardMemDocs{docs: map[string]*boardrepo.BoardDocument{}}
}

func (m *boardMemDocs) ConditionalWrite(_ context.Context, uuid string, expected int64, content string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nextN > 0 {
		m.nextN--
		return errors.New("forced storage failure")
	}
	cur, ok := m.docs[uuid]
	if ok && cur.Version != expected {
		return boardrepo.ErrConflict
	}
	// Absent doc -> insert (heal path), mirroring Mongo ReplaceOne upsert:
	// the replacement doc is stored verbatim with version expected+1.
	m.docs[uuid] = &boardrepo.BoardDocument{BoardUUID: uuid, Version: expected + 1, Content: content}
	return nil
}

func (m *boardMemDocs) Get(_ context.Context, uuid string) (*boardrepo.BoardDocument, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.docs[uuid]; ok {
		cp := *d
		return &cp, nil
	}
	return nil, nil
}

func (m *boardMemDocs) Restore(_ context.Context, uuid string, writtenVersion int64, prior *boardrepo.BoardDocument) error {
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

// ── sqlite meta store (real boardrepo.BoardRepo against glebarez/sqlite) ─

func newBoardMeta(t *testing.T) *boardrepo.BoardRepo {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := g.AutoMigrate(&boardmodel.Board{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &boardrepo.BoardRepo{DB: g}
}

const boardUID int64 = 42

func TestCreateAndGet(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, err := svc.Create(context.Background(), boardUID, "导图一", boardsvc.KindMindmap, `{"data":"v1"}`)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if meta.Version != 1 {
		t.Fatalf("version = %d, want 1", meta.Version)
	}
	detail, err := svc.GetDetail(context.Background(), boardUID, meta.UUID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if detail.Content == nil || *detail.Content != `{"data":"v1"}` {
		t.Fatalf("content = %v", detail.Content)
	}
}

func TestCreateInvalidKind(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	if _, err := svc.Create(context.Background(), boardUID, "x", "neon4j", ""); !errors.Is(err, boardsvc.ErrInvalidInput) {
		t.Fatalf("err = %v, want boardsvc.ErrInvalidInput", err)
	}
}

func TestUpdateHappyPath(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "t", boardsvc.KindMindmap, "")
	title := "new title"
	updated, err := svc.Update(context.Background(), boardUID, meta.UUID, meta.Version,
		boardsvc.UpdateParams{Content: boardStrPtr(`{"v":2}`), Title: &title})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != meta.Version+1 {
		t.Fatalf("version = %d, want %d", updated.Version, meta.Version+1)
	}
	detail, _ := svc.GetDetail(context.Background(), boardUID, meta.UUID)
	if detail.Title != "new title" || detail.Content == nil || *detail.Content != `{"v":2}` {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestUpdateMissingIfMatchIs428(t *testing.T) {
	// Update() itself requires a parsed ifMatch; the router enforces 428.
	// Here: passing a sentinel mismatched value must yield 409 semantics.
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "t", boardsvc.KindMindmap, "")
	_, err := svc.Update(context.Background(), boardUID, meta.UUID, meta.Version+5,
		boardsvc.UpdateParams{Content: boardStrPtr("{}")})
	if !errors.Is(err, boardsvc.ErrConflict) {
		t.Fatalf("err = %v, want boardsvc.ErrConflict", err)
	}
}

func TestConcurrentUpdateLoser409AndNoClobber(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "t", boardsvc.KindMindmap, `{"v":0}`)

	// Both writers read version 1.
	winner, err := svc.Update(context.Background(), boardUID, meta.UUID, 1, boardsvc.UpdateParams{Content: boardStrPtr(`{"winner":true}`)})
	if err != nil {
		t.Fatalf("winner: %v", err)
	}
	_, err = svc.Update(context.Background(), boardUID, meta.UUID, 1, boardsvc.UpdateParams{Content: boardStrPtr(`{"loser":true}`)})
	if !errors.Is(err, boardsvc.ErrConflict) {
		t.Fatalf("loser err = %v, want boardsvc.ErrConflict", err)
	}
	detail, _ := svc.GetDetail(context.Background(), boardUID, meta.UUID)
	if detail.Content == nil || *detail.Content != `{"winner":true}` {
		t.Fatalf("body clobbered: %v", detail.Content)
	}
	if detail.Version != winner.Version {
		t.Fatalf("version skew: meta %d vs winner %d", detail.Version, winner.Version)
	}
}

func TestStorageErrorRollsBackBody(t *testing.T) {
	docs := newBoardMemDocs()
	svc := boardsvc.NewBoardService(newBoardMeta(t), docs, boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "t", boardsvc.KindMindmap, `{"v":0}`)

	docs.mu.Lock()
	docs.nextN = 1 // next ConditionalWrite (body write inside Update) fails
	docs.mu.Unlock()

	_, err := svc.Update(context.Background(), boardUID, meta.UUID, meta.Version, boardsvc.UpdateParams{Content: boardStrPtr(`{"new":1}`)})
	if !errors.Is(err, boardsvc.ErrStorage) {
		t.Fatalf("err = %v, want boardsvc.ErrStorage", err)
	}
	detail, _ := svc.GetDetail(context.Background(), boardUID, meta.UUID)
	if detail.Content == nil || *detail.Content != `{"v":0}` {
		t.Fatalf("body changed after failed update: %v", detail.Content)
	}
}

func TestRollbackOnLostMetaRace(t *testing.T) {
	// Simulate: Mongo write wins, but MySQL bump finds 0 rows (another
	// writer bumped metadata in between). Service must roll back the body
	// and return 409.
	docs := newBoardMemDocs()
	meta := newBoardMeta(t)
	svc := boardsvc.NewBoardService(meta, docs, boardcache.NewInMemory())
	created, _ := svc.Create(context.Background(), boardUID, "t", boardsvc.KindMindmap, `{"v":0}`)

	// Another writer advances metadata behind our back.
	if _, err := meta.BumpVersion(context.Background(), boardUID, created.UUID, 1, nil, nil); err != nil {
		t.Fatalf("background bump: %v", err)
	}

	// Our writer still believes version=1; boardMemDocs doc version is 1 too, so
	// the Mongo conditional write succeeds — then the meta bump must fail.
	_, err := svc.Update(context.Background(), boardUID, created.UUID, 1, boardsvc.UpdateParams{Content: boardStrPtr(`{"sneaky":1}`)})
	if !errors.Is(err, boardsvc.ErrConflict) {
		t.Fatalf("err = %v, want boardsvc.ErrConflict", err)
	}
	detail, _ := svc.GetDetail(context.Background(), boardUID, created.UUID)
	if detail.Content == nil || *detail.Content != `{"v":0}` {
		t.Fatalf("rollback failed, body = %v", detail.Content)
	}
}

func TestOwnershipIsolation(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "mine", boardsvc.KindMindmap, "")
	if _, err := svc.GetDetail(context.Background(), boardUID+1, meta.UUID); !errors.Is(err, boardsvc.ErrNotFound) {
		t.Fatalf("err = %v, want boardsvc.ErrNotFound", err)
	}
	if err := svc.Delete(context.Background(), boardUID+1, meta.UUID); !errors.Is(err, boardsvc.ErrNotFound) {
		t.Fatalf("err = %v, want boardsvc.ErrNotFound", err)
	}
	if _, err := svc.GetDetail(context.Background(), boardUID, meta.UUID); err != nil {
		t.Fatalf("owner lost access: %v", err)
	}
}

func TestSoftDeleteHidesBoard(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, _ := svc.Create(context.Background(), boardUID, "gone", boardsvc.KindMindmap, "")
	if err := svc.Delete(context.Background(), boardUID, meta.UUID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := svc.GetDetail(context.Background(), boardUID, meta.UUID); !errors.Is(err, boardsvc.ErrNotFound) {
		t.Fatalf("err = %v, want boardsvc.ErrNotFound", err)
	}
	boards, total, _ := svc.ListMetas(context.Background(), boardUID, "", 1, 20)
	if total != 0 || len(boards) != 0 {
		t.Fatalf("soft-deleted board still listed: total=%d", total)
	}
}

func TestListPaginationAndPin(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	ctx := context.Background()
	a, _ := svc.Create(ctx, boardUID, "a", boardsvc.KindMindmap, "")
	b, _ := svc.Create(ctx, boardUID, "b", boardsvc.KindMindmap, "")
	svc.Create(ctx, boardUID, "c", boardsvc.KindWhiteboard, "")

	// Touch b so it is strictly the most recent. On Windows time.Now()
	// resolution (~0.5ms) can make back-to-back writes share a timestamp,
	// so give the clock a moment to advance first.
	time.Sleep(20 * time.Millisecond)
	if _, err := svc.Update(ctx, boardUID, b.UUID, b.Version, boardsvc.UpdateParams{Content: boardStrPtr(`{}`)}); err != nil {
		t.Fatalf("touch b: %v", err)
	}

	if _, err := svc.SetPin(ctx, boardUID, a.UUID, true); err != nil {
		t.Fatalf("pin: %v", err)
	}
	boards, total, _ := svc.ListMetas(ctx, boardUID, "", 1, 20)
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	if boards[0].UUID != a.UUID || !boards[0].IsPinned {
		t.Fatalf("pinned board not first: %+v", boards[0])
	}
	if boards[1].UUID != b.UUID {
		t.Fatalf("most recent not second: %+v", boards[1])
	}
	wb, _, _ := svc.ListMetas(ctx, boardUID, boardsvc.KindWhiteboard, 1, 20)
	if len(wb) != 1 || wb[0].Title != "c" {
		t.Fatalf("kind filter broken: %+v", wb)
	}
}

func TestContentTooBig(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	big := make([]byte, boardsvc.MaxContentBytes+1)
	_, err := svc.Update(context.Background(), boardUID, "nope", 1, boardsvc.UpdateParams{Content: boardStrPtr(string(big))})
	if !errors.Is(err, boardsvc.ErrContentTooBig) {
		t.Fatalf("err = %v, want boardsvc.ErrContentTooBig", err)
	}
}

func boardStrPtr(s string) *string { return &s }

func TestDuplicateTitleRejected(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	if _, err := svc.Create(context.Background(), boardUID, "同名", boardsvc.KindMindmap, ""); err != nil {
		t.Fatalf("create: %v", err)
	}
	// 同 boardUID+kind 重名 -> 400（boardsvc.ErrDuplicateName）。
	if _, err := svc.Create(context.Background(), boardUID, "同名", boardsvc.KindMindmap, ""); !errors.Is(err, boardsvc.ErrDuplicateName) {
		t.Fatalf("create dup = %v, want boardsvc.ErrDuplicateName", err)
	}
	// 不同 kind 同名允许（导图/白板是两个独立命名空间）。
	if _, err := svc.Create(context.Background(), boardUID, "同名", boardsvc.KindWhiteboard, ""); err != nil {
		t.Fatalf("create same title other kind: %v", err)
	}
	// 其他用户的同名允许。
	if _, err := svc.Create(context.Background(), boardUID+1, "同名", boardsvc.KindMindmap, ""); err != nil {
		t.Fatalf("create same title other boardUID: %v", err)
	}

	// 重命名为已存在的名称 -> 400；改回自己 -> 通过。
	meta, _ := svc.Create(context.Background(), boardUID, "甲", boardsvc.KindMindmap, "")
	other, _ := svc.Create(context.Background(), boardUID, "乙", boardsvc.KindMindmap, "")
	dup := "甲"
	if _, err := svc.Update(context.Background(), boardUID, other.UUID, other.Version,
		boardsvc.UpdateParams{Title: &dup}); !errors.Is(err, boardsvc.ErrDuplicateName) {
		t.Fatalf("rename dup = %v, want boardsvc.ErrDuplicateName", err)
	}
	self := "乙"
	if _, err := svc.Update(context.Background(), boardUID, other.UUID, other.Version,
		boardsvc.UpdateParams{Title: &self}); err != nil {
		t.Fatalf("rename to self: %v", err)
	}

	// 软删除后名称可复用。
	if err := svc.Delete(context.Background(), boardUID, meta.UUID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := svc.Create(context.Background(), boardUID, "甲", boardsvc.KindMindmap, ""); err != nil {
		t.Fatalf("reuse title after delete: %v", err)
	}
}

func TestCreateEmptyTitleNormalized(t *testing.T) {
	svc := boardsvc.NewBoardService(newBoardMeta(t), newBoardMemDocs(), boardcache.NewInMemory())
	meta, err := svc.Create(context.Background(), boardUID, "  ", boardsvc.KindMindmap, "")
	if err != nil {
		t.Fatalf("create empty title: %v", err)
	}
	if meta.Title != "未命名看板" {
		t.Fatalf("title = %q, want default", meta.Title)
	}
}
