package mongostore

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"app-cloud/internal/config"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoStore — access to the shared MongoDB collections used by the drive:
// cloud_drive_documents (parsed full text, owned by app-cloud) and
// asr_documents (read-only; cloud videos keep bvid=upload_uuid, cid=0).
type MongoStore struct {
	client *mongo.Client
	db     *mongo.Database
}

func NewMongoStore(ctx context.Context, cfg *config.Config) (*MongoStore, error) {
	if strings.TrimSpace(cfg.Mongo.URI) == "" {
		return &MongoStore{}, nil // disabled — preview/ASR lookups degrade gracefully
	}
	client, err := mongo.Connect(options.Client().ApplyURI(cfg.Mongo.URI))
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		return nil, err
	}
	return &MongoStore{client: client, db: client.Database(cfg.Mongo.Database)}, nil
}

// Close disconnects (nil-safe when disabled).
func (m *MongoStore) Close(ctx context.Context) error {
	if m == nil || m.client == nil {
		return nil
	}
	return m.client.Disconnect(ctx)
}

// ASRPreview returns up to maxLen chars of the latest ASR text for a cloud
// video (bvid=upload_uuid, cid=0 placeholder — parity with the Python detail
// endpoint).
func (m *MongoStore) ASRPreview(ctx context.Context, uploadUUID string, maxLen int) string {
	if m == nil || m.db == nil {
		return ""
	}
	var doc struct {
		Content string `bson:"content"`
	}
	err := m.db.Collection("asr_documents").FindOne(ctx,
		bson.M{"bvid": uploadUUID},
		options.FindOne().SetSort(bson.M{"version": -1}),
	).Decode(&doc)
	if err != nil {
		return ""
	}
	if len(doc.Content) > maxLen {
		return doc.Content[:maxLen]
	}
	return doc.Content
}

// DocumentPreview returns a cleaned slice of the parsed document text stored
// in cloud_drive_documents (HTML tags stripped — parity with the Python
// preview endpoint).
func (m *MongoStore) DocumentPreview(ctx context.Context, uid int64, uploadUUID string,
	offset, limit int) (string, int, map[string]any) {
	if m == nil || m.db == nil {
		return "", 0, nil
	}
	var doc struct {
		Content string         `bson:"content"`
		DocMeta map[string]any `bson:"doc_meta"`
	}
	err := m.db.Collection("cloud_drive_documents").FindOne(ctx,
		bson.M{"upload_uuid": uploadUUID, "uid": uid},
		options.FindOne().SetProjection(bson.M{"content": 1, "doc_meta": 1, "_id": 0}),
	).Decode(&doc)
	if err != nil {
		return "", 0, nil
	}
	cleaned := htmlTagRe.ReplaceAllString(doc.Content, "")
	total := len(cleaned)
	end := offset + limit
	if end > total {
		end = total
	}
	if offset > total {
		offset = total
	}
	return cleaned[offset:end], total, doc.DocMeta
}

// UpsertParsedDocument stores the parsed full text (pipeline phase 1).
func (m *MongoStore) UpsertParsedDocument(ctx context.Context, uploadUUID string, uid int64,
	title, sourceType, contentSource, content, contentHash string, docMeta map[string]any) error {
	if m == nil || m.db == nil {
		return errors.New("mongo disabled")
	}
	_, err := m.db.Collection("cloud_drive_documents").UpdateOne(ctx,
		bson.M{"upload_uuid": uploadUUID},
		bson.M{"$set": bson.M{
			"upload_uuid":    uploadUUID,
			"uid":            uid,
			"title":          title,
			"source_type":    sourceType,
			"content_source": contentSource,
			"content":        content,
			"content_hash":   contentHash,
			"doc_meta":       docMeta,
			"updated_at":     time.Now().UTC(),
		}},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}

// DeleteParsedDocument removes the full-text record (purge path).
func (m *MongoStore) DeleteParsedDocument(ctx context.Context, uploadUUID string) error {
	if m == nil || m.db == nil {
		return nil
	}
	_, err := m.db.Collection("cloud_drive_documents").DeleteMany(ctx,
		bson.M{"upload_uuid": uploadUUID})
	return err
}

// UpsertSummary stores the L1 routing summary alongside the parsed document
// (same collection — one read serves both full text and routing metadata).
// summaryContentHash ties the summary to the exact content version it was
// generated from; the query layer treats a mismatch as stale.
// sum is accepted as any (bson-marshalled via struct tags) so this package
// stays decoupled from the service layer that owns the summary type.
func (m *MongoStore) UpsertSummary(ctx context.Context, uploadUUID string, uid int64,
	contentHash, model string, sum any) error {
	if m == nil || m.db == nil {
		return errors.New("mongo disabled")
	}
	_, err := m.db.Collection("cloud_drive_documents").UpdateOne(ctx,
		bson.M{"upload_uuid": uploadUUID},
		bson.M{"$set": bson.M{
			"uid":                  uid,
			"summary":              sum,
			"summary_model":        model,
			"summary_content_hash": contentHash,
			"updated_at":           time.Now().UTC(),
		}},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}

// GetSummariesByUUIDs returns summary sub-documents for the given files
// (projection excludes the full text — the routing judge never needs it).
func (m *MongoStore) GetSummariesByUUIDs(ctx context.Context, uid int64,
	uploadUUIDs []string) ([]map[string]any, error) {
	if m == nil || m.db == nil {
		return nil, errors.New("mongo disabled")
	}
	if len(uploadUUIDs) == 0 {
		return nil, nil
	}
	cur, err := m.db.Collection("cloud_drive_documents").Find(ctx,
		bson.M{"uid": uid, "upload_uuid": bson.M{"$in": uploadUUIDs}, "summary": bson.M{"$exists": true}},
		options.Find().SetProjection(bson.M{
			"upload_uuid": 1, "title": 1, "summary": 1, "_id": 0,
		}),
	)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	out := []map[string]any{}
	for cur.Next(ctx) {
		var row map[string]any
		if err := cur.Decode(&row); err != nil {
			continue
		}
		out = append(out, row)
	}
	return out, cur.Err()
}

// htmlTagRe strips residual HTML tags from parsed text (parity).
var htmlTagRe = regexp.MustCompile(`<[^>]*>`)
