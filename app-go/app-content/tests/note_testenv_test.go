package tests

import (
	notesvc "app-content/internal/service/note"
	"context"
	"fmt"
	"testing"
	"time"

	notemodel "app-content/internal/model/note"
	noterepo "app-content/internal/repo/note"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// ── Test doubles ─────────────────────────────────────────────────────

// fakeMongo implements ContentStore in memory (parity with the Python
// tests' _FakeMongo).
type fakeMongo struct {
	contents  map[string]string // note_uuid -> content_md
	revisions map[string][]mongoRevision
	failWrite bool
	// now — 测试注入时钟。修订时间戳必须走它：快照闸门比较的是
	// svc.now 与修订 CreatedAt，若用真实墙钟，固定假时钟的测试
	// （TestSnapshotPolicy）会在假日期过后必然失败（时间炸弹）。
	now func() time.Time
}

type mongoRevision struct {
	note  string
	md    string
	note_ *string
	at    time.Time
}

func newFakeMongo() *fakeMongo {
	return &fakeMongo{
		contents:  map[string]string{},
		revisions: map[string][]mongoRevision{},
		now:       time.Now,
	}
}

func (f *fakeMongo) UpsertContent(_ context.Context, noteUUID string, _ int64, contentMD string) (string, error) {
	if f.failWrite {
		return "", fmt.Errorf("mongo down")
	}
	f.contents[noteUUID] = contentMD
	return "doc-" + noteUUID, nil
}

func (f *fakeMongo) GetContent(_ context.Context, noteUUID string) (*noterepo.NoteContent, error) {
	if md, ok := f.contents[noteUUID]; ok {
		return &noterepo.NoteContent{NoteUUID: noteUUID, ContentMD: md}, nil
	}
	return nil, nil
}

func (f *fakeMongo) DeleteContent(_ context.Context, noteUUID string) (int64, error) {
	n := int64(0)
	if _, ok := f.contents[noteUUID]; ok {
		delete(f.contents, noteUUID)
		n = 1
	}
	return n, nil
}

func (f *fakeMongo) InsertRevision(_ context.Context, noteUUID, contentMD string, revisionNote *string) (string, error) {
	if f.failWrite {
		return "", fmt.Errorf("mongo down")
	}
	id := fmt.Sprintf("rev-%d", len(f.revisions[noteUUID])+1)
	f.revisions[noteUUID] = append(f.revisions[noteUUID], mongoRevision{
		note: noteUUID, md: contentMD, note_: revisionNote, at: f.now().UTC(),
	})
	return id, nil
}

func (f *fakeMongo) ListRevisions(_ context.Context, noteUUID string, limit int) ([]noterepo.RevisionMeta, error) {
	revs := f.revisions[noteUUID]
	// newest-first
	out := make([]noterepo.RevisionMeta, 0, len(revs))
	for i := len(revs) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, noterepo.RevisionMeta{
			RevisionID: fmt.Sprintf("rev-%d", i+1), NoteUUID: noteUUID,
			RevisionNote: revs[i].note_, CreatedAt: revs[i].at,
		})
	}
	return out, nil
}

func (f *fakeMongo) GetRevision(_ context.Context, revisionID string) (*noterepo.RevisionFull, error) {
	for uuid_, revs := range f.revisions {
		for i, rev := range revs {
			if fmt.Sprintf("rev-%d", i+1) == revisionID {
				return &noterepo.RevisionFull{
					RevisionMeta: noterepo.RevisionMeta{
						RevisionID: revisionID, NoteUUID: uuid_,
						RevisionNote: rev.note_, CreatedAt: rev.at,
					},
					ContentMD: rev.md,
				}, nil
			}
		}
	}
	return nil, nil
}

// testEnv wires a real NoteRepo against in-memory SQLite + fakeMongo.
type testEnv struct {
	svc   *notesvc.NoteService
	db    *gorm.DB
	mongo *fakeMongo
	clock time.Time
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&notemodel.Note{}, &notemodel.NoteAnchor{}, &notemodel.NoteShare{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	env := &testEnv{mongo: newFakeMongo(), db: db, clock: time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)}
	// fakeMongo 的修订时间戳走同一个注入时钟（否则真实墙钟 vs 固定假时钟
	// 相减为负，快照闸门永远跳过）。
	env.mongo.now = func() time.Time { return env.clock }
	noteRepo := noterepo.NewNoteRepo(env.db)
	noteRepo.Now = func() time.Time { return env.clock }
	env.svc = notesvc.NewNoteService(noteRepo, env.mongo)
	env.svc.SetClock(func() time.Time { return env.clock })
	return env
}

// advance bumps the injected clock so svc/repo/fakeMongo all move together.
func (e *testEnv) advance(d time.Duration) { e.clock = e.clock.Add(d) }
