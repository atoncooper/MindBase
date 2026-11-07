// Mongo data access for asr_documents — port of
// app/repository/mongo_asr_repository.py. Document shape and the
// is_latest flip are byte-compatible with the Python writer.
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

// ErrStorageUnavailable wraps every Mongo failure (503-mapped by the router).
var ErrStorageUnavailable = errors.New("mongo storage unavailable")

func wrapStorage(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
}

// ASRContentRepo owns the asr_documents collection access. Nil-safe (nil db
// = disabled: reads degrade, writes fail).
type ASRContentRepo struct {
	db *mongo.Database
}

func NewASRContentRepo(db *mongo.Database) *ASRContentRepo { return &ASRContentRepo{db: db} }

// ASRDoc mirrors the note_documents-era shape of asr_documents.
type ASRDoc struct {
	VideoID       int64     `bson:"video_id"`
	BvID          string    `bson:"bvid"`
	CID           int64     `bson:"cid"`
	PageIndex     int       `bson:"page_index"`
	PageTitle     string    `bson:"page_title"`
	Content       string    `bson:"content"`
	ContentSource string    `bson:"content_source"`
	Version       int       `bson:"version"`
	IsLatest      bool      `bson:"is_latest"`
	CreatedAt     time.Time `bson:"created_at"`
}

// SaveASR marks previous versions not-latest and inserts the new doc.
func (r *ASRContentRepo) SaveASR(ctx context.Context, doc *ASRDoc) (string, error) {
	if r.db == nil {
		return "", fmt.Errorf("%w: MongoDB is not connected — ASR content cannot be saved", ErrStorageUnavailable)
	}
	if _, err := r.db.Collection("asr_documents").UpdateMany(ctx,
		bson.M{"bvid": doc.BvID, "cid": doc.CID, "is_latest": true},
		bson.M{"$set": bson.M{"is_latest": false}},
	); err != nil {
		return "", wrapStorage(err)
	}
	doc.IsLatest = true
	doc.CreatedAt = time.Now().UTC()
	res, err := r.db.Collection("asr_documents").InsertOne(ctx, doc)
	if err != nil {
		return "", wrapStorage(err)
	}
	if oid, ok := res.InsertedID.(bson.ObjectID); ok {
		return oid.Hex(), nil
	}
	return "", nil
}

// UpsertContent overwrites the latest doc's content in place (user_edit
// path — no new version, parity with update_content).
func (r *ASRContentRepo) UpsertContent(ctx context.Context, doc *ASRDoc) error {
	if r.db == nil {
		return fmt.Errorf("%w: MongoDB is not connected — ASR content cannot be saved", ErrStorageUnavailable)
	}
	_, err := r.db.Collection("asr_documents").UpdateOne(ctx,
		bson.M{"bvid": doc.BvID, "cid": doc.CID, "is_latest": true},
		bson.M{"$set": bson.M{
			"content":        doc.Content,
			"content_source": doc.ContentSource,
			"page_title":     doc.PageTitle,
			"updated_at":     time.Now().UTC(),
		}},
		options.UpdateOne().SetUpsert(true),
	)
	return wrapStorage(err)
}

func (r *ASRContentRepo) GetLatest(ctx context.Context, bvid string, cid int64) (*ASRDoc, error) {
	if r.db == nil {
		return nil, nil
	}
	var doc ASRDoc
	err := r.db.Collection("asr_documents").FindOne(ctx,
		bson.M{"bvid": bvid, "cid": cid, "is_latest": true},
		options.FindOne().SetSort(bson.M{"version": -1}),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, wrapStorage(err)
	}
	return &doc, nil
}

func (r *ASRContentRepo) ListVersions(ctx context.Context, bvid string, cid int64, limit int) ([]ASRDoc, error) {
	if r.db == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 100
	}
	cursor, err := r.db.Collection("asr_documents").Find(ctx,
		bson.M{"bvid": bvid, "cid": cid},
		options.Find().SetSort(bson.M{"version": -1}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, wrapStorage(err)
	}
	defer cursor.Close(ctx)
	var docs []ASRDoc
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, wrapStorage(err)
	}
	return docs, nil
}

// DeleteAll removes every version of a page (used by folder sync removal —
// only after the caller confirms the bvid belongs to nobody).
func (r *ASRContentRepo) DeleteAll(ctx context.Context, bvid string, cid int64) (int64, error) {
	if r.db == nil {
		return 0, nil
	}
	res, err := r.db.Collection("asr_documents").DeleteMany(ctx, bson.M{"bvid": bvid, "cid": cid})
	return res.DeletedCount, wrapStorage(err)
}
