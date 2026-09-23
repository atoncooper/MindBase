// Package repo provides the data-access layer: MySQL metadata (board table)
// and MongoDB body (board_documents). Pure data access — no business rules.
package repo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"app-board/internal/model"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"gorm.io/gorm"
)

// ── MySQL metadata ──────────────────────────────────────────────────

// BoardRepo is the MySQL metadata store. Every query is scoped by uid:
// app-board trusts the APISIX-injected X-Uid and enforces ownership here
// (rows of other users are invisible -> 404 semantics upstream).
type BoardRepo struct {
	DB *gorm.DB
}

// GetByUUID loads one non-deleted board owned by uid. gorm.ErrRecordNotFound
// means "not found OR not yours" — callers map both to 404 (no existence leak).
func (r *BoardRepo) GetByUUID(ctx context.Context, uid int64, uuid string) (*model.Board, error) {
	var b model.Board
	err := r.DB.WithContext(ctx).Where(
		"uuid = ? AND uid = ? AND deleted = false", uuid, uid,
	).First(&b).Error
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// List returns one page of the user's boards (deleted excluded), pinned
// first then most-recently-updated. kind filters when non-empty.
func (r *BoardRepo) List(ctx context.Context, uid int64, kind string, page, pageSize int) ([]model.Board, int64, error) {
	q := r.DB.WithContext(ctx).Model(&model.Board{}).Where("uid = ? AND deleted = false", uid)
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count boards: %w", err)
	}
	var boards []model.Board
	err := q.Order("is_pinned DESC, updated_at DESC").
		Offset((page - 1) * pageSize).Limit(pageSize).
		Find(&boards).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list boards: %w", err)
	}
	return boards, total, nil
}

// Create inserts the metadata row (version starts at 1).
func (r *BoardRepo) Create(ctx context.Context, b *model.Board) error {
	return r.DB.WithContext(ctx).Create(b).Error
}

// UpdatePin flips the pinned flag and returns the fresh row.
func (r *BoardRepo) UpdatePin(ctx context.Context, uid int64, uuid string, pinned bool) (*model.Board, error) {
	res := r.DB.WithContext(ctx).Model(&model.Board{}).Where(
		"uuid = ? AND uid = ? AND deleted = false", uuid, uid,
	).Update("is_pinned", pinned)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return r.GetByUUID(ctx, uid, uuid)
}

// TitleExists reports whether another non-deleted board of the same uid+kind
// already carries the title (exact match). excludeUUID skips the board being
// renamed itself; empty kind matches any kind. Check-then-insert is not
// atomic — acceptable at this scale (single-user UI flows), a true guard
// would need a nullable deleted_at + unique index.
func (r *BoardRepo) TitleExists(ctx context.Context, uid int64, kind, title, excludeUUID string) (bool, error) {
	q := r.DB.WithContext(ctx).Model(&model.Board{}).Where(
		"uid = ? AND deleted = false AND title = ?", uid, title)
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	if excludeUUID != "" {
		q = q.Where("uuid <> ?", excludeUUID)
	}
	var count int64
	if err := q.Count(&count).Error; err != nil {
		return false, fmt.Errorf("count boards by title: %w", err)
	}
	return count > 0, nil
}

// SoftDelete marks the row deleted (Mongo body kept for recovery).
func (r *BoardRepo) SoftDelete(ctx context.Context, uid int64, uuid string) error {
	res := r.DB.WithContext(ctx).Model(&model.Board{}).Where(
		"uuid = ? AND uid = ? AND deleted = false", uuid, uid,
	).Update("deleted", true)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// BumpVersion is the optimistic-lock commit: version = expected -> expected+1
// (plus optional title/isPinned). RowsAffected == 0 means a concurrent writer
// won (or the row vanished) — caller maps to 409. It never touches rows with
// a different version, so no lost update is possible on the metadata side.
func (r *BoardRepo) BumpVersion(ctx context.Context, uid int64, uuid string, expectedVersion int64, title *string, pinned *bool) (int64, error) {
	updates := map[string]any{"version": expectedVersion + 1, "updated_at": time.Now()}
	if title != nil {
		updates["title"] = *title
	}
	if pinned != nil {
		updates["is_pinned"] = *pinned
	}
	res := r.DB.WithContext(ctx).Model(&model.Board{}).Where(
		"uuid = ? AND uid = ? AND deleted = false AND version = ?", uuid, uid, expectedVersion,
	).Updates(updates)
	return res.RowsAffected, res.Error
}

// ── MongoDB body ────────────────────────────────────────────────────

// BoardDocument mirrors one Mongo document. Version mirrors the MySQL
// metadata version at the last successful content write — this is what makes
// the conditional body write (ConditionalWrite) the serialization point.
type BoardDocument struct {
	BoardUUID string    `bson:"board_uuid" json:"board_uuid"`
	Version   int64     `bson:"version" json:"version"`
	Content   string    `bson:"content" json:"content"` // verbatim editor JSON
	UpdatedAt time.Time `bson:"updated_at" json:"updated_at"`
}

// DocStore abstracts the body store so service logic is unit-testable
// without a live Mongo (tests provide an in-memory implementation).
type DocStore interface {
	// ConditionalWrite replaces the body iff the stored version equals
	// expectedVersion; the new document is stored with version+1. An absent
	// document is created (upsert), enabling the create flow (expected 0 ->
	// stored 1). Returns ErrConflict when the expected version doesn't match.
	ConditionalWrite(ctx context.Context, boardUUID string, expectedVersion int64, content string) error
	// Get returns the current document; (nil, nil) when absent.
	Get(ctx context.Context, boardUUID string) (*BoardDocument, error)
	// Restore rolls back a failed two-store commit to the state BEFORE the
	// write: prior==nil (create path) deletes the just-written doc, otherwise
	// it reinstates the prior document. Both guarded on writtenVersion so a
	// concurrent winner's write is never clobbered. Best-effort (no error
	// surfaced to callers).
	Restore(ctx context.Context, boardUUID string, writtenVersion int64, prior *BoardDocument) error
}

// ErrConflict signals an optimistic-lock mismatch on the body store.
var ErrConflict = errors.New("version conflict")

// MongoDocRepo is the MongoDB implementation of DocStore.
type MongoDocRepo struct {
	Col *mongo.Collection
}

func (r *MongoDocRepo) ConditionalWrite(ctx context.Context, boardUUID string, expectedVersion int64, content string) error {
	filter := bson.M{"board_uuid": boardUUID, "version": expectedVersion}
	doc := BoardDocument{
		BoardUUID: boardUUID,
		Version:   expectedVersion + 1,
		Content:   content,
		UpdatedAt: time.Now(),
	}
	res, err := r.Col.ReplaceOne(ctx, filter, doc, options.Replace().SetUpsert(true))
	if err != nil {
		// Duplicate key on the board_uuid unique index: the document exists
		// but at a different version (filter missed -> upsert tried to
		// insert). Same meaning as a version mismatch.
		if mongo.IsDuplicateKeyError(err) {
			return ErrConflict
		}
		return fmt.Errorf("replace board document: %w", err)
	}
	// An upsert-INSERT (document absent: create flow or heal path) reports
	// MatchedCount=0 but UpsertedCount=1 — that is a SUCCESS, not a conflict.
	// A true conflict (document present at a different version) is a plain
	// replace with no match and no upsert.
	if res.MatchedCount == 0 && res.UpsertedCount == 0 {
		return ErrConflict
	}
	return nil
}

func (r *MongoDocRepo) Get(ctx context.Context, boardUUID string) (*BoardDocument, error) {
	var doc BoardDocument
	err := r.Col.FindOne(ctx, bson.M{"board_uuid": boardUUID}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find board document: %w", err)
	}
	return &doc, nil
}

// Restore rolls back to the pre-write state, guarded on the version the
// failed write produced. If the guard misses, a concurrent winner advanced
// the document already and we must not touch it.
func (r *MongoDocRepo) Restore(ctx context.Context, boardUUID string, writtenVersion int64, prior *BoardDocument) error {
	guard := bson.M{"board_uuid": boardUUID, "version": writtenVersion}
	if prior == nil {
		_, err := r.Col.DeleteOne(ctx, guard)
		return err
	}
	res, err := r.Col.ReplaceOne(ctx, guard, *prior)
	if err != nil {
		return err
	}
	_ = res
	return nil
}
