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

// htmlTagRe strips residual HTML tags from parsed text (parity).
var htmlTagRe = regexp.MustCompile(`<[^>]*>`)
