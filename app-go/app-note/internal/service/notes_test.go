package service

import (
	"strings"
	"testing"
	"time"
)

// Port of app/test/notes/test_notes_service.py — the behaviour contract.
// uid=1 is the owner, uid=2 is the other user.

func mustCreate(t *testing.T, env *testEnv, uid int64, title, contentMD string) *NoteDetail {
	t.Helper()
	d, err := env.svc.CreateNote(t.Context(), env.db, uid, title, "video", "BV1xx:1", contentMD)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return d
}

// ── Create ───────────────────────────────────────────────────────────

func TestCreateWritesBothStores(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "标题", "# hello")
	if d.UUID == "" || d.ContentMD != "# hello" {
		t.Fatalf("unexpected detail: %+v", d)
	}
	if d.ContentLength != len([]rune("# hello")) {
		t.Errorf("content_length = %d (code points expected)", d.ContentLength)
	}
	if env.mongo.contents[d.UUID] != "# hello" {
		t.Errorf("mongo content missing")
	}
}

func TestCreateInvalidTargetType(t *testing.T) {
	env := newTestEnv(t)
	if _, err := env.svc.CreateNote(t.Context(), env.db, 1, "t", "folder", "x", ""); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestCreateSanitizesContent(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "hi <script>alert(1)</script> there")
	if strings.Contains(d.ContentMD, "<script") || strings.Contains(d.ContentMD, "alert") {
		t.Fatalf("content not sanitized: %q", d.ContentMD)
	}
}

func TestCreateEmptyTitleDefaults(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "", "x")
	if d.Title != "无标题" {
		t.Errorf("title = %q, want 无标题", d.Title)
	}
}

// ── Read / List ──────────────────────────────────────────────────────

func TestGetCrossUserIs404(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	if _, err := env.svc.GetNote(t.Context(), env.db, d.UUID, 2); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestListOnlyOwnAndFilterByTarget(t *testing.T) {
	env := newTestEnv(t)
	mustCreate(t, env, 1, "a", "x")
	mustCreate(t, env, 2, "b", "y")
	notes, total, err := env.svc.ListNotes(t.Context(), env.db, 1, "", "", 1, 20)
	if err != nil || total != 1 || len(notes) != 1 {
		t.Fatalf("list uid=1: n=%d total=%d err=%v", len(notes), total, err)
	}
	env.svc.CreateNote(t.Context(), env.db, 1, "c", "cloud_file", "up-1", "z")
	notes, total, _ = env.svc.ListNotes(t.Context(), env.db, 1, "cloud_file", "up-1", 1, 20)
	if total != 1 || notes[0].TargetID != "up-1" {
		t.Fatalf("target filter failed: total=%d", total)
	}
}

// ── Update ───────────────────────────────────────────────────────────

func TestUpdateWritesContent(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "v1")
	updated, err := env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("v2"), nil, nil)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.ContentMD != "v2" {
		t.Fatalf("content = %q", updated.ContentMD)
	}
}

func TestUpdateHashShortCircuit(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "same")
	// Same content → no Mongo write, no revision, updated_at still ticks.
	before := env.mongo.contents[d.UUID]
	updated, err := env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("same"), nil, nil)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if env.mongo.contents[d.UUID] != before {
		t.Fatal("mongo should not be rewritten on identical content")
	}
	if len(env.mongo.revisions[d.UUID]) != 0 {
		t.Fatal("no revision expected for identical content")
	}
	if !updated.UpdatedAt.Time.Equal(d.UpdatedAt.Time) {
		t.Fatal("updated_at must not advance on a hash short-circuit no-op")
	}
}

func TestUpdateIfMatchConflict(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "v1")
	stale := d.UpdatedAt.Add(-time.Minute)
	_, err := env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("v2"), nil, &stale)
	conflict, ok := err.(*ConflictError)
	if !ok {
		t.Fatalf("want ConflictError, got %v", err)
	}
	if !conflict.ServerUpdateAt.Equal(d.UpdatedAt.Time) {
		t.Fatalf("server_updated_at mismatch")
	}
}

func TestUpdateCrossUser404(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "v1")
	if _, err := env.svc.UpdateNote(t.Context(), env.db, d.UUID, 2, nil, strPtr("x"), nil, nil); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestUpdateEmptyRejected(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "v1")
	if _, err := env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, nil, nil, nil); err == nil {
		t.Fatal("empty update should be rejected")
	}
}

// ── Snapshot policy ──────────────────────────────────────────────────

func TestSnapshotPolicy(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "short")

	// First content-bearing update: old content existed but no revisions →
	// snapshot taken.
	env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("completely different body"), nil, nil)
	if len(env.mongo.revisions[d.UUID]) != 1 {
		t.Fatalf("want 1 revision after first big update, got %d", len(env.mongo.revisions[d.UUID]))
	}

	// Update again within 10 min (< 30% diff) → no snapshot.
	env.clock = env.clock.Add(5 * time.Minute)
	env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("completely different body!"), nil, nil)
	if len(env.mongo.revisions[d.UUID]) != 1 {
		t.Fatalf("churn guard failed: %d revisions", len(env.mongo.revisions[d.UUID]))
	}

	// After 10 min with >= 30% diff → snapshot.
	env.clock = env.clock.Add(11 * time.Minute)
	env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil,
		strPtr("a wholly new and much longer body that differs a lot from before"), nil, nil)
	if len(env.mongo.revisions[d.UUID]) != 2 {
		t.Fatalf("want 2 revisions, got %d", len(env.mongo.revisions[d.UUID]))
	}
}

// ── Delete ───────────────────────────────────────────────────────────

func TestDeleteSoftAndRevokesShare(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	share, err := env.svc.CreateShare(t.Context(), env.db, d.UUID, 1, nil)
	if err != nil {
		t.Fatalf("share: %v", err)
	}
	if err := env.svc.DeleteNote(t.Context(), env.db, d.UUID, 1); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := env.svc.GetNote(t.Context(), env.db, d.UUID, 1); err != ErrNotFound {
		t.Fatalf("get after delete: %v", err)
	}
	notes, total, _ := env.svc.ListNotes(t.Context(), env.db, 1, "", "", 1, 20)
	if total != 0 || len(notes) != 0 {
		t.Fatal("deleted note must not be listed")
	}
	if _, err := env.svc.GetSharedView(t.Context(), env.db, share.ShareToken); err != ErrNotFound {
		t.Fatalf("share must be dead after delete: %v", err)
	}
}

// ── Sharing ──────────────────────────────────────────────────────────

func TestShareLifecycle(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	share, err := env.svc.CreateShare(t.Context(), env.db, d.UUID, 1, nil)
	if err != nil {
		t.Fatalf("share: %v", err)
	}
	if !strings.HasPrefix(share.ShareURL, "/notes/shared/") {
		t.Fatalf("share_url = %q", share.ShareURL)
	}
	view, err := env.svc.GetSharedView(t.Context(), env.db, share.ShareToken)
	if err != nil {
		t.Fatalf("shared view: %v", err)
	}
	if view.ViewCount != 1 || view.ContentMD != "body" {
		t.Fatalf("view = %+v", view)
	}
	// Revoke → dead.
	if err := env.svc.RevokeShare(t.Context(), env.db, d.UUID, 1); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := env.svc.GetSharedView(t.Context(), env.db, share.ShareToken); err != ErrNotFound {
		t.Fatal("revoked share must 404")
	}
}

func TestShareExpiry(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	days := 1
	share, _ := env.svc.CreateShare(t.Context(), env.db, d.UUID, 1, &days)
	env.clock = env.clock.Add(25 * time.Hour)
	if _, err := env.svc.GetSharedView(t.Context(), env.db, share.ShareToken); err != ErrNotFound {
		t.Fatal("expired share must 404")
	}
}

func TestNewShareRevokesOld(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	first, _ := env.svc.CreateShare(t.Context(), env.db, d.UUID, 1, nil)
	second, _ := env.svc.CreateShare(t.Context(), env.db, d.UUID, 1, nil)
	if _, err := env.svc.GetSharedView(t.Context(), env.db, first.ShareToken); err != ErrNotFound {
		t.Fatal("old share must be revoked when a new one is created")
	}
	if _, err := env.svc.GetSharedView(t.Context(), env.db, second.ShareToken); err != nil {
		t.Fatalf("new share must work: %v", err)
	}
}

// ── Anchors ──────────────────────────────────────────────────────────

func TestAnchors(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "body")
	label := "锚点"
	a, err := env.svc.AddAnchor(t.Context(), env.db, d.UUID, 1, "block-1", 3, &label)
	if err != nil {
		t.Fatalf("add anchor: %v", err)
	}
	if a.Label == nil || *a.Label != label {
		t.Fatalf("anchor = %+v", a)
	}
	detail, _ := env.svc.GetNote(t.Context(), env.db, d.UUID, 1)
	if len(detail.Anchors) != 1 || detail.Anchors[0].BlockID != "block-1" {
		t.Fatalf("detail anchors = %+v", detail.Anchors)
	}
	if err := env.svc.DeleteAnchor(t.Context(), env.db, d.UUID, a.ID, 1); err != nil {
		t.Fatalf("delete anchor: %v", err)
	}
	if err := env.svc.DeleteAnchor(t.Context(), env.db, d.UUID, a.ID, 1); err != ErrNotFound {
		t.Fatal("second delete should 404")
	}
	if _, err := env.svc.AddAnchor(t.Context(), env.db, d.UUID, 2, "b", 0, nil); err != ErrNotFound {
		t.Fatal("cross-user anchor should 404")
	}
}

// ── Revisions ────────────────────────────────────────────────────────

func TestRevisionsAndRestore(t *testing.T) {
	env := newTestEnv(t)
	d := mustCreate(t, env, 1, "t", "v1")
	revs, err := env.svc.ListRevisions(t.Context(), env.db, d.UUID, 1)
	if err != nil || len(revs) != 0 {
		t.Fatalf("initial revisions = %v (err %v)", revs, err)
	}
	env.svc.UpdateNote(t.Context(), env.db, d.UUID, 1, nil, strPtr("v2 big change...."), nil, nil)
	revs, _ = env.svc.ListRevisions(t.Context(), env.db, d.UUID, 1)
	if len(revs) != 1 {
		t.Fatalf("want 1 revision, got %d", len(revs))
	}
	// Restore to the snapshot (the auto-snapshot holds the v2 body).
	detail, err := env.svc.RestoreRevision(t.Context(), env.db, d.UUID, revs[0].RevisionID, 1)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if detail.ContentMD != "v2 big change...." {
		t.Fatalf("restored content = %q", detail.ContentMD)
	}
	if detail.RevisionCount != 2 {
		t.Fatalf("revision_count = %d, want 2", detail.RevisionCount)
	}
	revs, _ = env.svc.ListRevisions(t.Context(), env.db, d.UUID, 1)
	if len(revs) != 2 || revs[0].RevisionNote == nil || !strings.HasPrefix(*revs[0].RevisionNote, "restored from") {
		t.Fatalf("post-restore revisions = %+v", revs)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

func strPtr(s string) *string { return &s }
