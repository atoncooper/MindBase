// Package service — notes business logic. Port of
// app/services/notes/service.py + app/services/notes/markdown.py, preserving
// the wire contract the frontend depends on (If-Match optimistic locking,
// single-active share, revision snapshot policy, cross-user 404).
package service

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"app-content/internal/apperr"
	"app-content/internal/model/note"
	"app-content/internal/repo/note"
)

// Revision policy thresholds (parity with the Python backend).
const (
	RevisionMinInterval = 10 * time.Minute
	RevisionDiffRatio   = 0.30
	MaxContentBytes     = 256 * 1024 // 256 KB cap (utf-8 bytes)
)

// ErrNotFound maps to 404 (also used for cross-user access so note
// existence is never leaked).
var ErrNotFound = apperr.New(http.StatusNotFound, "note_not_found", "笔记不存在")

// ErrStorageUnavailable re-exports the data-access sentinel so HTTP handlers
// map storage failures to 503 without importing the repo package.
var ErrStorageUnavailable = repo.ErrStorageUnavailable

// validationErr builds a 400 with the user-facing message.
func validationErr(msg string) *apperr.Error {
	return apperr.New(http.StatusBadRequest, "note_invalid_input", msg)
}

// conflictErr builds a 409 with the structured detail the frontend expects
// (rendered as {"detail": {"error":"conflict", ...}}).
func conflictErr(noteUUID string, serverUpdateAt time.Time) *apperr.Error {
	return apperr.New(http.StatusConflict, "note_conflict", "optimistic-lock conflict").WithMeta(map[string]any{
		"error":             "conflict",
		"note_uuid":         noteUUID,
		"server_updated_at": FormatNaiveUTC(serverUpdateAt),
	})
}

// ContentStore abstracts the Mongo-backed content/revisions store
// (implemented by repo.MongoContentRepo; faked in tests).
type ContentStore interface {
	UpsertContent(ctx context.Context, noteUUID string, uid int64, contentMD string) (string, error)
	GetContent(ctx context.Context, noteUUID string) (*repo.NoteContent, error)
	DeleteContent(ctx context.Context, noteUUID string) (int64, error)
	InsertRevision(ctx context.Context, noteUUID, contentMD string, revisionNote *string) (string, error)
	ListRevisions(ctx context.Context, noteUUID string, limit int) ([]repo.RevisionMeta, error)
	GetRevision(ctx context.Context, revisionID string) (*repo.RevisionFull, error)
}

// NoteService coordinates MySQL metadata + MongoDB content.
type NoteService struct {
	repo  *repo.NoteRepo
	mongo ContentStore
	now   func() time.Time // injectable clock for tests
}

// NewNoteService wires the MySQL repo (owns the *gorm.DB), Mongo content store
// and injectable clock. Controllers never see the DB handle.
func NewNoteService(r *repo.NoteRepo, m ContentStore) *NoteService {
	// Nil content store → disabled-mode Mongo repo (reads degrade, writes
	// 503) instead of a nil-interface panic on first use.
	if m == nil {
		m = repo.NewMongoContentRepo(nil)
	}
	// Clock truncated to whole seconds: MySQL DATETIME (no fsp) truncates
	// fractional seconds on write, so the stored updated_at — and therefore
	// the If-Match comparison — is second-granular. Keeping the in-memory
	// value aligned with what the DB round-trips prevents phantom conflicts.
	return &NoteService{
		repo:  r,
		mongo: m,
		now:   func() time.Time { return time.Now().UTC().Truncate(time.Second) },
	}
}

// SetClock overrides the clock (tests only).
func (s *NoteService) SetClock(f func() time.Time) { s.now = f }

// ── Create ───────────────────────────────────────────────────────────

// CreateNote writes Mongo content first, then MySQL metadata; on MySQL
// failure the Mongo doc is removed (orphan cleanup) and the error propagates.
func (s *NoteService) CreateNote(ctx context.Context, uid int64,
	title, targetType, targetID, contentMD string) (*NoteDetail, error) {
	if targetType != "video" && targetType != "cloud_file" {
		return nil, validationErr(fmt.Sprintf("invalid target_type: %s", targetType))
	}
	if len(contentMD) > MaxContentBytes {
		return nil, validationErr("content_md exceeds 256 KB cap")
	}

	cleanMD := SanitizeMarkdown(contentMD)
	noteUUID := newUUID()

	docID, err := s.mongo.UpsertContent(ctx, noteUUID, uid, cleanMD)
	if err != nil {
		return nil, err
	}
	hash := ContentHash(cleanMD)
	now := s.now()
	note := &model.Note{
		UUID:          noteUUID,
		UID:           uid,
		Title:         defaultTitle(title),
		TargetType:    targetType,
		TargetID:      targetID,
		ContentDocID:  docID,
		ContentLength: runeLen(cleanMD),
		ContentHash:   &hash,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.repo.Create(ctx, note); err != nil {
		// Orphan Mongo doc — remove it, then fail.
		_, _ = s.mongo.DeleteContent(ctx, noteUUID)
		return nil, err
	}
	return s.buildDetail(ctx, note)
}

// ── Read ─────────────────────────────────────────────────────────────

// GetNote fetches metadata + content + anchors + active share.
// Cross-user access returns ErrNotFound (no existence leak).
func (s *NoteService) GetNote(ctx context.Context, noteUUID string, uid int64) (*NoteDetail, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}
	return s.buildDetail(ctx, note)
}

func (s *NoteService) buildDetail(ctx context.Context, note *model.Note) (*NoteDetail, error) {
	content := ""
	if doc, err := s.mongo.GetContent(ctx, note.UUID); err != nil {
		return nil, err
	} else if doc != nil {
		content = doc.ContentMD
	}
	anchors, err := s.repo.ListAnchors(ctx, note.ID)
	if err != nil {
		return nil, err
	}
	share, err := s.repo.GetActiveShareForNote(ctx, note.UUID)
	if err != nil {
		return nil, err
	}
	d := &NoteDetail{MetaView: metaView(*note), ContentMD: content}
	for _, a := range anchors {
		d.Anchors = append(d.Anchors, anchorView(a))
	}
	if share != nil {
		d.ShareToken = &share.ShareToken
		// 永久分享 expires_at 为 NULL —— 无条件解引用会让该笔记的详情接口
		// 永久 500（nil pointer panic）。
		if share.ExpiresAt != nil {
			d.ShareExpiresAt = &NaiveUTC{*share.ExpiresAt}
		}
	}
	return d, nil
}

// ListNotes returns (meta view list, total) — no content, no persistence model
// leaking to the HTTP layer.
func (s *NoteService) ListNotes(ctx context.Context, uid int64,
	targetType, targetID string, page, pageSize int) ([]MetaView, int64, error) {
	rows, total, err := s.repo.ListByUser(ctx, uid, targetType, targetID, page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	out := make([]MetaView, 0, len(rows))
	for _, n := range rows {
		out = append(out, metaView(n))
	}
	return out, total, nil
}

// ── Update ───────────────────────────────────────────────────────────

// UpdateNote applies field changes with sha256 short-circuit and the
// revision snapshot policy. All field changes commit in one update_meta so
// updated_at advances by exactly one tick per request.
func (s *NoteService) UpdateNote(ctx context.Context, noteUUID string, uid int64,
	title *string, contentMD *string, isPinned *bool, ifMatch *time.Time) (*NoteDetail, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}

	if ifMatch != nil && !ifMatch.Equal(note.UpdatedAt) {
		return nil, conflictErr(noteUUID, note.UpdatedAt)
	}

	// Reject no-op updates so silent field-mapping regressions surface as
	// 400 instead of a misleading 200.
	if title == nil && contentMD == nil && isPinned == nil {
		return nil, validationErr("empty update: at least one field required")
	}

	upd := repo.MetaUpdate{UpdatedAt: s.now()}
	bumpRevision := false

	if contentMD != nil {
		if len(*contentMD) > MaxContentBytes {
			return nil, validationErr("content_md exceeds 256 KB cap")
		}
		cleanMD := SanitizeMarkdown(*contentMD)
		computedHash := ContentHash(cleanMD)
		if note.ContentHash == nil || computedHash != *note.ContentHash {
			// Capture OLD content BEFORE the upsert — the snapshot policy
			// needs the pre-update body for a real diff.
			oldMD := ""
			if oldDoc, err := s.mongo.GetContent(ctx, noteUUID); err != nil {
				return nil, err
			} else if oldDoc != nil {
				oldMD = oldDoc.ContentMD
			}
			if _, err := s.mongo.UpsertContent(ctx, noteUUID, uid, cleanMD); err != nil {
				return nil, err
			}
			bumpRevision, err = s.shouldSnapshot(ctx, noteUUID, oldMD, cleanMD)
			if err != nil {
				return nil, err
			}
			newLen := runeLen(cleanMD)
			upd.ContentLength = &newLen
			upd.ContentHash = &computedHash
			if bumpRevision {
				note_ := "auto-snapshot"
				if _, err := s.mongo.InsertRevision(ctx, noteUUID, cleanMD, &note_); err != nil {
					return nil, err
				}
			}
		}
	}
	upd.Title = title
	upd.IsPinned = isPinned
	upd.BumpRevision = bumpRevision

	// Single commit for all field changes — skipped entirely when content
	// was unchanged and no metadata field is set (Python parity: updated_at
	// must not advance on a hash short-circuit no-op).
	hasChange := title != nil || isPinned != nil || upd.ContentLength != nil ||
		upd.ContentHash != nil || bumpRevision
	if hasChange {
		if err := s.repo.UpdateMeta(ctx, note, upd); err != nil {
			return nil, err
		}
	}

	// Full detail (meta + content_md + anchors + share) so the frontend
	// auto-save loop gets a fresh serverUpdatedAtRef — returning meta only
	// would break it (same reason as the Python implementation).
	return s.buildDetail(ctx, note)
}

// shouldSnapshot decides whether to write a revision snapshot:
//   - empty new content → never
//   - no prior revision + non-empty new content → snapshot
//   - last revision < 10 min ago → skip (churn guard)
//   - otherwise snapshot when diff ratio >= 30%
func (s *NoteService) shouldSnapshot(ctx context.Context, noteUUID, oldContent, newContent string) (bool, error) {
	if newContent == "" {
		return false, nil
	}
	if oldContent == "" {
		return true, nil
	}
	revisions, err := s.mongo.ListRevisions(ctx, noteUUID, 1)
	if err != nil {
		return false, err
	}
	if len(revisions) > 0 {
		lastRevAt := revisions[0].CreatedAt
		if s.now().Sub(lastRevAt) < RevisionMinInterval {
			return false, nil
		}
	}
	return DiffRatio(oldContent, newContent) >= RevisionDiffRatio, nil
}

// ── Delete ───────────────────────────────────────────────────────────

// DeleteNote soft-deletes the MySQL row, revokes all shares, and
// hard-deletes the Mongo content doc. Revisions are preserved.
func (s *NoteService) DeleteNote(ctx context.Context, noteUUID string, uid int64) error {
	note, err := s.repo.GetByUUID(ctx, noteUUID, true)
	if err != nil {
		return err
	}
	if note == nil || note.UID != uid {
		return ErrNotFound
	}
	if err := s.repo.DeleteNoteTx(ctx, note, s.now()); err != nil {
		return err
	}
	// Mongo content cleanup is idempotent; the metadata transaction above is
	// already committed, so a failure here leaves an orphan doc, never a live
	// share for a deleted note.
	if _, err := s.mongo.DeleteContent(ctx, noteUUID); err != nil {
		return err
	}
	return nil
}

// ── Anchors ──────────────────────────────────────────────────────────

func (s *NoteService) AddAnchor(ctx context.Context, noteUUID string, uid int64,
	blockID string, position int, label *string) (*AnchorView, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}
	anchor := &model.NoteAnchor{
		NoteID:    note.ID,
		BlockID:   blockID,
		Position:  position,
		Label:     label,
		CreatedAt: s.now(),
	}
	if err := s.repo.AddAnchor(ctx, anchor); err != nil {
		return nil, err
	}
	v := anchorView(*anchor)
	return &v, nil
}

func (s *NoteService) DeleteAnchor(ctx context.Context, noteUUID string, anchorID int, uid int64) error {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return err
	}
	if note == nil || note.UID != uid {
		return ErrNotFound
	}
	deleted, err := s.repo.DeleteAnchor(ctx, note.ID, anchorID)
	if err != nil {
		return err
	}
	if !deleted {
		return ErrNotFound
	}
	return nil
}

// ── Sharing ──────────────────────────────────────────────────────────

// CreateShare revokes prior shares (one active at a time) and creates a new
// token (43-char url-safe, parity with Python token_urlsafe(32)).
func (s *NoteService) CreateShare(ctx context.Context, noteUUID string, uid int64, expires_in_days *int) (*ShareView, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}
	if err := s.repo.RevokeShares(ctx, noteUUID); err != nil {
		return nil, err
	}
	var expiresAt *time.Time
	if expires_in_days != nil {
		t := s.now().AddDate(0, 0, *expires_in_days)
		expiresAt = &t
	}
	share := &model.NoteShare{
		NoteUUID:     noteUUID,
		ShareToken:   newShareToken(),
		CreatedByUID: uid,
		ExpiresAt:    expiresAt,
		CreatedAt:    s.now(),
	}
	if err := s.repo.CreateShare(ctx, share); err != nil {
		return nil, err
	}
	return &ShareView{
		ShareToken: share.ShareToken,
		ShareURL:   "/notes/shared/" + share.ShareToken,
		ExpiresAt:  naivePtr(share.ExpiresAt),
	}, nil
}

func (s *NoteService) RevokeShare(ctx context.Context, noteUUID string, uid int64) error {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return err
	}
	if note == nil || note.UID != uid {
		return ErrNotFound
	}
	return s.repo.RevokeShares(ctx, noteUUID)
}

// GetSharedView — public read-only access, no auth required. Invalid /
// expired / revoked → ErrNotFound. Bumps view_count.
func (s *NoteService) GetSharedView(ctx context.Context, shareToken string) (*SharedView, error) {
	share, err := s.repo.GetActiveShareByToken(ctx, shareToken)
	if err != nil {
		return nil, err
	}
	if share == nil {
		return nil, ErrNotFound
	}
	note, err := s.repo.GetByUUID(ctx, share.NoteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil {
		return nil, ErrNotFound
	}
	contentMD := ""
	if doc, err := s.mongo.GetContent(ctx, note.UUID); err != nil {
		return nil, err
	} else if doc != nil {
		contentMD = doc.ContentMD
	}
	if err := s.repo.IncrementViewCount(ctx, share); err != nil {
		return nil, err
	}
	return &SharedView{
		Title:      note.Title,
		ContentMD:  contentMD,
		TargetType: note.TargetType,
		TargetID:   note.TargetID,
		SharedAt:   NaiveUTC{share.CreatedAt},
		ViewCount:  share.ViewCount + 1,
	}, nil
}

// ── Revisions ────────────────────────────────────────────────────────

func (s *NoteService) ListRevisions(ctx context.Context, noteUUID string, uid int64) ([]RevisionView, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}
	metas, err := s.mongo.ListRevisions(ctx, noteUUID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]RevisionView, 0, len(metas))
	for _, m := range metas {
		out = append(out, revisionView(m))
	}
	return out, nil
}

// RestoreRevision replaces the live content with the snapshot body,
// bumps revision_count, and inserts a "restored from {id}" snapshot.
func (s *NoteService) RestoreRevision(ctx context.Context, noteUUID, revisionID string, uid int64) (*NoteDetail, error) {
	note, err := s.repo.GetByUUID(ctx, noteUUID, false)
	if err != nil {
		return nil, err
	}
	if note == nil || note.UID != uid {
		return nil, ErrNotFound
	}
	rev, err := s.mongo.GetRevision(ctx, revisionID)
	if err != nil {
		return nil, err
	}
	if rev == nil || rev.NoteUUID != noteUUID {
		return nil, ErrNotFound
	}
	cleanMD := SanitizeMarkdown(rev.ContentMD)
	if _, err := s.mongo.UpsertContent(ctx, noteUUID, uid, cleanMD); err != nil {
		return nil, err
	}
	newHash := ContentHash(cleanMD)
	newLen := runeLen(cleanMD)
	note_ := fmt.Sprintf("restored from %s", revisionID)
	if _, err := s.mongo.InsertRevision(ctx, noteUUID, cleanMD, &note_); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateMeta(ctx, note, repo.MetaUpdate{
		ContentLength: &newLen,
		ContentHash:   &newHash,
		BumpRevision:  true,
		UpdatedAt:     s.now(),
	}); err != nil {
		return nil, err
	}
	return s.buildDetail(ctx, note)
}
