// Engine — the vectorization machinery: MinIO download → extraction →
// chunk → embed → Milvus insert (+ Mongo full text), with the Python
// pipeline's idempotency and rollback semantics. Pure machinery by design:
// orchestration concerns (L1 summary, routing-graph writes) live in the
// service layer and are injected through VectorizeHooks — this package must
// not import the service package.
package pipeline

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/infra/minio"
	"app-cloud/internal/model"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// VectorStore — the port for vector persistence (implemented by
// internal/milvusstore.MilvusStore). Keeping it here keeps this package free
// of the milvus SDK, so its tests run on every platform.
type VectorStore interface {
	CountByUploadUUID(ctx context.Context, uploadUUID string) (int, error)
	DeleteByUploadUUID(ctx context.Context, uploadUUID string) error
	InsertChunks(ctx context.Context, uploadUUID string, uid int64, partition time.Time, rows []model.ChunkRow) error
}

// Engine implements the service layer's VectorEngine port (structural
// typing — this package never imports service).
type Engine struct {
	db       *gorm.DB
	minio    *minio.Client
	mongo    *mongostore.MongoStore
	milvus   VectorStore
	embedder *Embedder
	files    *repo.FileRepo
	maxDoc   int64
}

func NewEngine(db *gorm.DB, mc *minio.Client, mongo *mongostore.MongoStore,
	milvus VectorStore, embedder *Embedder, maxDoc int64) *Engine {
	return &Engine{db: db, minio: mc, mongo: mongo, milvus: milvus,
		embedder: embedder, files: repo.NewFileRepo(), maxDoc: maxDoc}
}

// VectorizeHooks carries optional service-layer callbacks fired at fixed
// points of the run. Best-effort by contract: hook errors are ignored by the
// engine (durable-state concerns belong to the hook implementation).
type VectorizeHooks struct {
	// AfterExtract fires once the full text is extracted and persisted to
	// Mongo. text is the cleaned document text; contentHash is the sha256 of
	// the downloaded bytes (the idempotency key).
	AfterExtract func(ctx context.Context, f *model.CloudFile, text, contentHash string)
}

// Vectorize runs the full pipeline for one file. Returns the chunk count in
// Milvus (the existing count when the idempotency guard short-circuits).
func (e *Engine) Vectorize(ctx context.Context, f *model.CloudFile, hooks VectorizeHooks) (int, error) {
	// Pre-check the STORED size before reading the object into memory: the
	// upload path allows multi-GB objects for vectorizable mimes (e.g. a huge
	// pdf), and a full read of one would exhaust worker memory.
	if size, serr := e.minio.ObjectSize(ctx, f.ObjectKey); serr == nil && size > e.maxDoc {
		return 0, fmt.Errorf("%w: stored size %d bytes > limit %d", ErrDocTooLarge, size, e.maxDoc)
	}
	data, err := e.minio.GetObject(ctx, f.ObjectKey)
	if err != nil {
		return 0, fmt.Errorf("minio download: %w", err)
	}
	// Defense in depth: the pre-check may have raced with a concurrent write.
	if int64(len(data)) > e.maxDoc {
		return 0, fmt.Errorf("%w: downloaded %d bytes > limit %d", ErrDocTooLarge, len(data), e.maxDoc)
	}

	contentHash := sha256Hex(data)
	// Idempotency: done + same hash must mean Milvus actually has vectors —
	// verify, otherwise re-run (collection may have been recreated).
	if f.VectorStatus != nil && *f.VectorStatus == "done" && f.ContentHash != nil && *f.ContentHash == contentHash {
		actual, cerr := e.milvus.CountByUploadUUID(ctx, f.UploadUUID)
		if cerr == nil && actual > 0 {
			slog.Info("[PIPELINE] already vectorized, content unchanged", "upload_uuid", f.UploadUUID)
			if f.VectorChunkCount != nil {
				return *f.VectorChunkCount, nil
			}
			return actual, nil
		}
		slog.Warn("[PIPELINE] marked done but Milvus empty — re-vectorizing", "upload_uuid", f.UploadUUID)
	}

	// ── Phase 1: extract text → Mongo ──
	isVideo := strings.HasPrefix(strings.ToLower(f.MimeType), "video/")
	sourceType := "doc"
	if isVideo {
		sourceType = "drive"
	}
	cleaned, source, headings, err := e.extractText(ctx, f, data, contentHash, sourceType)
	if err != nil {
		return 0, err
	}
	if hooks.AfterExtract != nil {
		hooks.AfterExtract(ctx, f, cleaned, contentHash)
	}

	// ── Phase 2: chunking ──
	chunker := NewChunker()
	chunks := chunker.Chunk(cleaned)
	if len(chunks) == 0 {
		return 0, fmt.Errorf("chunking produced no chunks for %s", f.UploadUUID)
	}

	// ── Phase 3: embedding ──
	embedTexts := make([]string, len(chunks))
	for i, ch := range chunks {
		embedTexts[i] = EmbeddingText(ch.Text, ch.SectionTitle, displayTitle(f))
	}
	vectors, err := e.embedder.Embed(ctx, embedTexts)
	if err != nil {
		return 0, fmt.Errorf("embedding: %w", err)
	}

	// Clean stale chunks from prior failed runs before re-adding.
	_ = e.milvus.DeleteByUploadUUID(ctx, f.UploadUUID)

	// ── Phase 4: Milvus insert (partition = file.created_at month) ──
	partition := time.Now()
	if f.CreatedAt != nil {
		partition = *f.CreatedAt
	}
	rows := make([]model.ChunkRow, len(chunks))
	for i, ch := range chunks {
		rows[i] = model.ChunkRow{
			ChunkIndex:   i,
			ChunkID:      f.UploadUUID + ":" + itoa(i),
			Title:        displayTitle(f),
			Source:       source,
			SourceType:   sourceType,
			SectionTitle: ch.SectionTitle,
			ContentType:  ch.ContentType,
			Text:         embedTexts[i],
			Vector:       vectors[i],
		}
	}
	if err := e.milvus.InsertChunks(ctx, f.UploadUUID, f.UID, partition, rows); err != nil {
		return 0, err
	}

	// ── Phase 5: metadata (doc_parser + doc_meta + content_hash, success only) ──
	// content_hash closes the idempotency gate above: the next run of the
	// same unchanged content short-circuits instead of re-embedding.
	docMeta := map[string]any{}
	if len(headings) > 0 {
		docMeta["headings"] = headings
	}
	docMeta["source"] = source
	docMeta["source_type"] = sourceType
	metaJSON, _ := json.Marshal(docMeta)
	metaStr := string(metaJSON)
	_ = e.files.UpdateMeta(e.db, f.UploadUUID, f.UID, map[string]any{
		"doc_parser":   source,
		"doc_meta":     metaStr,
		"content_hash": contentHash,
	})

	return len(chunks), nil
}

// extractText extracts (and, for non-video, persists the full text to Mongo).
// Videos require existing ASR content in Mongo (parity — the drive has no
// auto-ASR path; without it the file ends failed with a clear message).
func (e *Engine) extractText(ctx context.Context, f *model.CloudFile, data []byte,
	contentHash, sourceType string) (string, string, []Heading, error) {
	if strings.HasPrefix(strings.ToLower(f.MimeType), "video/") {
		asr := e.mongo.ASRPreview(ctx, f.UploadUUID, 100<<20)
		if strings.TrimSpace(asr) == "" {
			return "", "", nil, fmt.Errorf("No ASR content for video %s. Run ASR first.", f.UploadUUID)
		}
		return asr, "asr", nil, nil
	}
	parsed, err := Extract(f.MimeType, f.OriginalName, data)
	if err != nil {
		return "", "", nil, err
	}
	if err := e.mongo.UpsertParsedDocument(ctx, f.UploadUUID, f.UID,
		f.OriginalName, sourceType, parsed.Source, parsed.Text, contentHash,
		map[string]any{
			"headings":    headingsToAny(parsed.Headings),
			"source":      parsed.Source,
			"source_type": sourceType,
		}); err != nil {
		return "", "", nil, fmt.Errorf("mongo upsert parsed doc: %w", err)
	}
	return parsed.Text, parsed.Source, parsed.Headings, nil
}

// CountChunks / DeleteChunks — the service layer's reconciliation surface.
func (e *Engine) CountChunks(ctx context.Context, uploadUUID string) (int, error) {
	return e.milvus.CountByUploadUUID(ctx, uploadUUID)
}

func (e *Engine) DeleteChunks(ctx context.Context, uploadUUID string) error {
	return e.milvus.DeleteByUploadUUID(ctx, uploadUUID)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func displayTitle(f *model.CloudFile) string {
	if f.Title != nil && strings.TrimSpace(*f.Title) != "" {
		return *f.Title
	}
	return f.OriginalName
}

func headingsToAny(hs []Heading) []map[string]any {
	out := make([]map[string]any, 0, len(hs))
	for _, h := range hs {
		out = append(out, map[string]any{"level": h.Level, "text": h.Text})
	}
	return out
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

// ErrDocTooLarge marks a stored document beyond the vectorization size
// limit — permanent for this content (mapped to not_supported upstream).
var ErrDocTooLarge = errors.New("document exceeds the vectorization size limit")
