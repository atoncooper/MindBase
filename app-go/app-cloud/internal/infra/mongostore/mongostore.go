package mongostore

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

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

// ParsedDocumentMeta is one parsed drive document listed for cloud
// knowledge-graph builds: identity and content version only, never the body.
type ParsedDocumentMeta struct {
	UploadUUID  string
	Title       string
	ContentHash string
	// SizeChars is the character count recorded when the text was persisted.
	// The listing deliberately excludes `content`, so no body text is loaded
	// (or measured) on the read path; documents written before size_chars
	// existed report 0. The per-document endpoint serves the exact value.
	SizeChars int
}

// ParsedDocument is one parsed drive document including its full text.
type ParsedDocument struct {
	UploadUUID  string
	Title       string
	ContentHash string
	SizeChars   int
	Text        string
}

// ListParsedDocuments pages one user's parsed documents that have usable body
// text, ordered by upload_uuid ascending; afterUploadUUID (empty = first page)
// is the exclusive lower bound, matching the upload_uuid cursor semantics of
// the KG M2M listing. The projection skips `content`: a 100-document page must
// not drag megabytes of text over the wire — size_chars is read from the value
// persisted by UpsertParsedDocument instead.
func (m *MongoStore) ListParsedDocuments(ctx context.Context, uid int64,
	afterUploadUUID string, limit int) ([]ParsedDocumentMeta, error) {
	if m == nil || m.db == nil || limit <= 0 {
		// Disabled store / no page size: nil-safe empty page, like the other
		// readers (the HTTP layer clamps limit into 1..100).
		return nil, nil
	}
	filter := bson.M{
		"uid":          uid,
		"content":      usableTextFilter(),
		"content_hash": usableTextFilter(),
	}
	if afterUploadUUID != "" {
		filter["upload_uuid"] = bson.M{"$gt": afterUploadUUID}
	}
	cur, err := m.db.Collection("cloud_drive_documents").Find(ctx, filter,
		options.Find().
			SetSort(bson.M{"upload_uuid": 1}).
			SetLimit(int64(limit)).
			SetProjection(bson.M{
				"upload_uuid": 1, "title": 1, "content_hash": 1, "size_chars": 1, "_id": 0,
			}),
	)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	out := make([]ParsedDocumentMeta, 0, limit)
	for cur.Next(ctx) {
		var row struct {
			UploadUUID  string `bson:"upload_uuid"`
			Title       string `bson:"title"`
			ContentHash string `bson:"content_hash"`
			SizeChars   int    `bson:"size_chars"`
		}
		if err := cur.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, ParsedDocumentMeta{
			UploadUUID:  row.UploadUUID,
			Title:       row.Title,
			ContentHash: row.ContentHash,
			SizeChars:   row.SizeChars,
		})
	}
	return out, cur.Err()
}

// GetParsedDocument returns one user's parsed document with its full text.
// (nil, nil) means "absent, no body text, or no content hash" — the HTTP layer
// maps that to 404 without distinguishing the cases (same as the drive detail
// contract). A nil/disabled store behaves identically.
func (m *MongoStore) GetParsedDocument(ctx context.Context, uid int64,
	uploadUUID string) (*ParsedDocument, error) {
	if m == nil || m.db == nil || uploadUUID == "" {
		return nil, nil
	}
	var row struct {
		UploadUUID  string `bson:"upload_uuid"`
		Title       string `bson:"title"`
		ContentHash string `bson:"content_hash"`
		Content     string `bson:"content"`
		SizeChars   int    `bson:"size_chars"`
	}
	err := m.db.Collection("cloud_drive_documents").FindOne(ctx,
		bson.M{"upload_uuid": uploadUUID, "uid": uid,
			"content": usableTextFilter(), "content_hash": usableTextFilter()},
		options.FindOne().SetProjection(bson.M{
			"upload_uuid": 1, "title": 1, "content_hash": 1, "content": 1,
			"size_chars": 1, "_id": 0,
		}),
	).Decode(&row)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &ParsedDocument{
		UploadUUID:  row.UploadUUID,
		Title:       row.Title,
		ContentHash: row.ContentHash,
		SizeChars:   row.SizeChars,
		Text:        row.Content,
	}, nil
}

// usableTextFilter matches a string field that exists and is neither null nor
// empty (the "parsed正文可用" gate shared by the KG reads).
func usableTextFilter() bson.M {
	return bson.M{"$exists": true, "$nin": []any{nil, ""}}
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
			// size_chars is persisted so the KG listing can report a size
			// without loading (or even transferring) the body text. Rune count
			// keeps it consistent with the summary size_chars convention
			// (one CJK character = 1), unlike len() which counts UTF-8 bytes.
			"size_chars": utf8.RuneCountInString(content),
			"doc_meta":   docMeta,
			"updated_at": time.Now().UTC(),
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

// StoredSummary — the summary sub-document plus its provenance. Summary stays
// a raw BSON map so this package never imports the service layer's summary
// type; the reader decodes it.
type StoredSummary struct {
	Summary     map[string]any
	Model       string
	ContentHash string
}

// GetSummaryByUUID returns the stored summary of one file for its owner.
// Documents written before the field existed simply have no summary — the
// result is (nil, nil). A nil/disabled store yields the same.
func (m *MongoStore) GetSummaryByUUID(ctx context.Context, uid int64,
	uploadUUID string) (*StoredSummary, error) {
	if m == nil || m.db == nil {
		return nil, nil
	}
	var doc struct {
		Summary     map[string]any `bson:"summary"`
		Model       string         `bson:"summary_model"`
		ContentHash string         `bson:"summary_content_hash"`
	}
	err := m.db.Collection("cloud_drive_documents").FindOne(ctx,
		bson.M{"upload_uuid": uploadUUID, "uid": uid, "summary": bson.M{"$exists": true}},
		options.FindOne().SetProjection(bson.M{
			"summary": 1, "summary_model": 1, "summary_content_hash": 1, "_id": 0,
		}),
	).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	if doc.Summary == nil {
		return nil, nil
	}
	return &StoredSummary{Summary: doc.Summary, Model: doc.Model, ContentHash: doc.ContentHash}, nil
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
