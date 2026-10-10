// Package repo — data access for notes / note_anchors / note_shares.
// Pure GORM queries; business rules live in the service layer. Port of
// app/repository/note_repository.py.
package repo

import (
	"context"
	"time"

	"app-note/internal/model"

	"gorm.io/gorm"
)

// MetaUpdate carries the optional field changes for UpdateMeta (nil = keep).
type MetaUpdate struct {
	Title         *string
	ContentLength *int
	ContentHash   *string
	IsPinned      *bool
	BumpRevision  bool
	// UpdatedAt is written verbatim (UTC) — one tick per request, set by
	// the service layer so every change in one request shares the stamp.
	UpdatedAt time.Time
}

// NoteRepo bundles the note-table queries (gorm.DB is safe for concurrent use).
// Now is the clock used for expiry checks — overridable in tests.
type NoteRepo struct {
	Now func() time.Time
}

func NewNoteRepo() *NoteRepo {
	return &NoteRepo{Now: func() time.Time { return time.Now().UTC() }}
}

func (r *NoteRepo) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now().UTC()
}

// ── Notes ────────────────────────────────────────────────────────────

func (r *NoteRepo) Create(ctx context.Context, db *gorm.DB, note *model.Note) error {
	return db.WithContext(ctx).Create(note).Error
}

func (r *NoteRepo) GetByUUID(ctx context.Context, db *gorm.DB, uuid string, includeDeleted bool) (*model.Note, error) {
	q := db.WithContext(ctx).Where("uuid = ?", uuid)
	if !includeDeleted {
		q = q.Where("is_deleted = ?", false)
	}
	var note model.Note
	if err := q.First(&note).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &note, nil
}

// ListByUser returns (notes, total) for a paginated, filtered list of
// non-deleted notes. Order: is_pinned desc, updated_at desc.
func (r *NoteRepo) ListByUser(ctx context.Context, db *gorm.DB, uid int64,
	targetType, targetID string, page, pageSize int) ([]model.Note, int64, error) {
	q := db.WithContext(ctx).Model(&model.Note{}).
		Where("uid = ? AND is_deleted = ?", uid, false)
	if targetType != "" {
		q = q.Where("target_type = ?", targetType)
	}
	if targetID != "" {
		q = q.Where("target_id = ?", targetID)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var notes []model.Note
	err := q.Order("is_pinned DESC, updated_at DESC").
		Limit(pageSize).Offset((page - 1) * pageSize).
		Find(&notes).Error
	return notes, total, err
}

// UpdateMeta applies the non-nil field changes plus bump_revision and the
// single updated_at tick in one commit (single-commit semantics port).
func (r *NoteRepo) UpdateMeta(ctx context.Context, db *gorm.DB, note *model.Note, upd MetaUpdate) error {
	values := map[string]any{"updated_at": upd.UpdatedAt}
	if upd.Title != nil {
		values["title"] = *upd.Title
	}
	if upd.ContentLength != nil {
		values["content_length"] = *upd.ContentLength
	}
	if upd.ContentHash != nil {
		values["content_hash"] = *upd.ContentHash
	}
	if upd.IsPinned != nil {
		values["is_pinned"] = *upd.IsPinned
	}
	if upd.BumpRevision {
		// Atomic SQL-side increment: two concurrent updaters (user auto-save
		// + note agent via M2M, which skips If-Match) must not lose a count.
		values["revision_count"] = gorm.Expr("revision_count + 1")
	}
	if err := db.WithContext(ctx).Model(&model.Note{}).
		Where("id = ?", note.ID).Updates(values).Error; err != nil {
		return err
	}
	// Reflect the new values on the in-memory row for serialization.
	if upd.Title != nil {
		note.Title = *upd.Title
	}
	if upd.ContentLength != nil {
		note.ContentLength = *upd.ContentLength
	}
	if upd.ContentHash != nil {
		note.ContentHash = upd.ContentHash
	}
	if upd.IsPinned != nil {
		note.IsPinned = *upd.IsPinned
	}
	if upd.BumpRevision {
		note.RevisionCount++
	}
	note.UpdatedAt = upd.UpdatedAt
	return nil
}

func (r *NoteRepo) SoftDelete(ctx context.Context, db *gorm.DB, note *model.Note, now time.Time) error {
	return db.WithContext(ctx).Model(&model.Note{}).
		Where("id = ?", note.ID).
		Updates(map[string]any{"is_deleted": true, "updated_at": now}).Error
}

// ── Anchors ──────────────────────────────────────────────────────────

func (r *NoteRepo) AddAnchor(ctx context.Context, db *gorm.DB, anchor *model.NoteAnchor) error {
	return db.WithContext(ctx).Create(anchor).Error
}

func (r *NoteRepo) ListAnchors(ctx context.Context, db *gorm.DB, noteID int) ([]model.NoteAnchor, error) {
	var anchors []model.NoteAnchor
	err := db.WithContext(ctx).
		Where("note_id = ?", noteID).
		Order("position ASC").
		Find(&anchors).Error
	return anchors, err
}

// DeleteAnchor removes one anchor scoped to the note; returns whether a row
// was deleted.
func (r *NoteRepo) DeleteAnchor(ctx context.Context, db *gorm.DB, noteID, anchorID int) (bool, error) {
	res := db.WithContext(ctx).
		Where("id = ? AND note_id = ?", anchorID, noteID).
		Delete(&model.NoteAnchor{})
	return res.RowsAffected > 0, res.Error
}

// ── Shares ───────────────────────────────────────────────────────────

func (r *NoteRepo) CreateShare(ctx context.Context, db *gorm.DB, share *model.NoteShare) error {
	return db.WithContext(ctx).Create(share).Error
}

// GetActiveShareByToken fetches a non-revoked, non-expired share by token.
func (r *NoteRepo) GetActiveShareByToken(ctx context.Context, db *gorm.DB, token string) (*model.NoteShare, error) {
	var share model.NoteShare
	err := db.WithContext(ctx).
		Where("share_token = ? AND is_revoked = ?", token, false).
		First(&share).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if share.ExpiresAt != nil && !share.ExpiresAt.After(r.now()) {
		return nil, nil
	}
	return &share, nil
}

// GetActiveShareForNote returns the most recent active share (owner display).
func (r *NoteRepo) GetActiveShareForNote(ctx context.Context, db *gorm.DB, noteUUID string) (*model.NoteShare, error) {
	var shares []model.NoteShare
	err := db.WithContext(ctx).
		Where("note_uuid = ? AND is_revoked = ?", noteUUID, false).
		Order("created_at DESC").
		Find(&shares).Error
	if err != nil {
		return nil, err
	}
	now := r.now()
	for i := range shares {
		if shares[i].ExpiresAt == nil || shares[i].ExpiresAt.After(now) {
			return &shares[i], nil
		}
	}
	return nil, nil
}

// RevokeShares revokes every active share of the note (single-active policy).
func (r *NoteRepo) RevokeShares(ctx context.Context, db *gorm.DB, noteUUID string) error {
	return db.WithContext(ctx).Model(&model.NoteShare{}).
		Where("note_uuid = ? AND is_revoked = ?", noteUUID, false).
		Update("is_revoked", true).Error
}

func (r *NoteRepo) IncrementViewCount(ctx context.Context, db *gorm.DB, share *model.NoteShare) error {
	// Atomic increment — concurrent share-page hits must not lose counts.
	return db.WithContext(ctx).Model(&model.NoteShare{}).
		Where("id = ?", share.ID).
		Update("view_count", gorm.Expr("view_count + 1")).Error
}
