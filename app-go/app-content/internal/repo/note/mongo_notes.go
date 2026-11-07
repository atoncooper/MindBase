// Mongo data access for note content (note_documents / note_revisions).
// The counterpart of notes.go (MySQL queries) — connection lifecycle lives
// in the mongostore package, all collection read/write operations live
// here. Port of app/repository/mongo_note_repository.py; same collections
// and document shapes the Python backend used — zero data migration.
//
// Error contract: every failure (driver error or disabled mode) is wrapped
// with ErrStorageUnavailable so the router can map it to 503 with a
// friendly detail instead of leaking internals as a generic 500.
package repo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	contentColl  = "note_documents"
	revisionColl = "note_revisions"
	defaultLimit = 100
)

// ErrStorageUnavailable — sentinel wrapped around every Mongo failure.
var ErrStorageUnavailable = errors.New("mongo storage unavailable")

// ErrContentDisabled — disabled mode (no Mongo configured / not connected).
// Same semantics as the Python backend's RuntimeError; also satisfies
// errors.Is(err, ErrStorageUnavailable).
var ErrContentDisabled = fmt.Errorf("%w: MongoDB is not connected — note content cannot be saved", ErrStorageUnavailable)

// wrapStorage tags raw driver failures with the 503-mapped sentinel.
func wrapStorage(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
}

// MongoContentRepo bundles the note-content queries. Nil-safe: all methods
// work with a nil db (disabled mode).
type MongoContentRepo struct {
	db *mongo.Database
}

// NewMongoContentRepo builds the repo from the mongostore handle; nil
// database = disabled mode (reads degrade, writes fail).
func NewMongoContentRepo(db *mongo.Database) *MongoContentRepo {
	return &MongoContentRepo{db: db}
}

// ── Content documents ────────────────────────────────────────────────

// UpsertContent inserts or replaces the content document for a note and
// returns the string form of the MongoDB _id (stored as content_doc_id in
// MySQL — same convention as the Python backend).
func (r *MongoContentRepo) UpsertContent(ctx context.Context, noteUUID string, uid int64, contentMD string) (string, error) {
	if r.db == nil {
		return "", ErrContentDisabled
	}
	now := time.Now().UTC()
	_, err := r.db.Collection(contentColl).UpdateOne(ctx,
		bson.M{"note_uuid": noteUUID},
		bson.M{
			"$set": bson.M{
				"note_uuid":  noteUUID,
				"uid":        uid,
				"content_md": contentMD,
				"updated_at": now,
			},
			"$setOnInsert": bson.M{"created_at": now},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return "", wrapStorage(err)
	}
	var doc struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = r.db.Collection(contentColl).FindOne(ctx,
		bson.M{"note_uuid": noteUUID},
		options.FindOne().SetProjection(bson.M{"_id": 1}),
	).Decode(&doc)
	if err != nil {
		return "", wrapStorage(err)
	}
	return doc.ID.Hex(), nil
}

// NoteContent mirrors the note_documents document shape.
type NoteContent struct {
	NoteUUID  string    `bson:"note_uuid"`
	UID       int64     `bson:"uid"`
	ContentMD string    `bson:"content_md"`
	Blocks    any       `bson:"blocks_json,omitempty"`
	CreatedAt time.Time `bson:"created_at"`
	UpdatedAt time.Time `bson:"updated_at"`
}

// GetContent returns the content document, or nil if missing / disabled.
func (r *MongoContentRepo) GetContent(ctx context.Context, noteUUID string) (*NoteContent, error) {
	if r.db == nil {
		return nil, nil
	}
	var doc NoteContent
	err := r.db.Collection(contentColl).FindOne(ctx,
		bson.M{"note_uuid": noteUUID},
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, wrapStorage(err)
	}
	return &doc, nil
}

// DeleteContent removes the content document (hard delete on note deletion).
// Disabled mode: no-op, 0 rows.
func (r *MongoContentRepo) DeleteContent(ctx context.Context, noteUUID string) (int64, error) {
	if r.db == nil {
		return 0, nil
	}
	res, err := r.db.Collection(contentColl).DeleteMany(ctx, bson.M{"note_uuid": noteUUID})
	if err != nil {
		return 0, wrapStorage(err)
	}
	return res.DeletedCount, nil
}

// ── Revisions ────────────────────────────────────────────────────────

// InsertRevision appends a snapshot and returns the revision id (hex).
func (r *MongoContentRepo) InsertRevision(ctx context.Context, noteUUID, contentMD string, revisionNote *string) (string, error) {
	if r.db == nil {
		return "", ErrContentDisabled
	}
	res, err := r.db.Collection(revisionColl).InsertOne(ctx, bson.M{
		"note_uuid":     noteUUID,
		"content_md":    contentMD,
		"revision_note": revisionNote,
		"created_at":    time.Now().UTC(),
	})
	if err != nil {
		return "", wrapStorage(err)
	}
	oid, ok := res.InsertedID.(bson.ObjectID)
	if !ok {
		return "", wrapStorage(errors.New("unexpected revision id type"))
	}
	return oid.Hex(), nil
}

// RevisionMeta is the list shape — content_md deliberately excluded (matches
// the Python list projection; the frontend only consumes id/note/created_at).
type RevisionMeta struct {
	RevisionID   string    `bson:"-"`
	NoteUUID     string    `bson:"note_uuid"`
	RevisionNote *string   `bson:"revision_note"`
	CreatedAt    time.Time `bson:"created_at"`
}

// RevisionFull is a single revision including the snapshot body (restore path).
type RevisionFull struct {
	RevisionMeta
	ContentMD string `bson:"content_md"`
}

// ListRevisions returns revisions newest-first, excluding the live content.
func (r *MongoContentRepo) ListRevisions(ctx context.Context, noteUUID string, limit int) ([]RevisionMeta, error) {
	if r.db == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	cursor, err := r.db.Collection(revisionColl).Find(ctx,
		bson.M{"note_uuid": noteUUID},
		options.Find().
			SetProjection(bson.M{"content_md": 0}).
			SetSort(bson.M{"created_at": -1}).
			SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, wrapStorage(err)
	}
	defer cursor.Close(ctx)
	var out []RevisionMeta
	for cursor.Next(ctx) {
		var doc struct {
			ID bson.ObjectID `bson:"_id"`
			RevisionMeta
		}
		if err := cursor.Decode(&doc); err != nil {
			return nil, wrapStorage(err)
		}
		doc.RevisionMeta.RevisionID = doc.ID.Hex()
		out = append(out, doc.RevisionMeta)
	}
	return out, wrapStorage(cursor.Err())
}

// GetRevision fetches a single revision including content. Returns nil when
// the id is malformed or missing.
func (r *MongoContentRepo) GetRevision(ctx context.Context, revisionID string) (*RevisionFull, error) {
	if r.db == nil {
		return nil, nil
	}
	oid, err := bson.ObjectIDFromHex(revisionID)
	if err != nil {
		return nil, nil
	}
	var doc struct {
		ID bson.ObjectID `bson:"_id"`
		RevisionFull
	}
	err = r.db.Collection(revisionColl).FindOne(ctx, bson.M{"_id": oid}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, wrapStorage(err)
	}
	doc.RevisionFull.RevisionID = doc.ID.Hex()
	return &doc.RevisionFull, nil
}
