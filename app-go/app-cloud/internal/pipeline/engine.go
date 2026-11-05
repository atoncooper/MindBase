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
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/metrics"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"
	"app-cloud/internal/utils"

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
	// ocr reads images and image-only PDFs; nil/unconfigured keeps those
	// files not_supported (the pre-OCR behaviour).
	ocr *OCRClient
	// extractPDFImages is the embedded-image extractor for scanned PDFs;
	// injectable so the OCR assembly is testable without binary fixtures.
	extractPDFImages pdfImageExtractor
}

func NewEngine(db *gorm.DB, mc *minio.Client, mongo *mongostore.MongoStore,
	milvus VectorStore, embedder *Embedder, maxDoc int64) *Engine {
	return &Engine{db: db, minio: mc, mongo: mongo, milvus: milvus,
		embedder: embedder, files: repo.NewFileRepo(), maxDoc: maxDoc,
		extractPDFImages: extractPDFImagesPDFCPU}
}

// SetOCR attaches the vision OCR client. A nil or unconfigured client is
// accepted: image and scanned-PDF files then stay not_supported.
func (e *Engine) SetOCR(ocr *OCRClient) { e.ocr = ocr }

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
		embedTexts[i] = EmbeddingText(ch.Text, ch.SectionTitle, utils.DisplayTitle(f))
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
			Title:        utils.DisplayTitle(f),
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
	parsed, err := e.parseDocument(ctx, f, data)
	if err != nil {
		return "", "", nil, err
	}
	if isVideoMime(f.MimeType) {
		// Video text comes from asr_documents; there is no parsed-document
		// row to write for it.
		return parsed.Text, parsed.Source, nil, nil
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

// parseDocument selects the text source for one file: video → existing ASR
// text, image → vision OCR, other documents → the text parsers. Image-only
// PDFs fall back to OCR of their embedded page images when it is configured.
func (e *Engine) parseDocument(ctx context.Context, f *model.CloudFile, data []byte) (*Parsed, error) {
	if isVideoMime(f.MimeType) {
		asr := e.mongo.ASRPreview(ctx, f.UploadUUID, 100<<20)
		if strings.TrimSpace(asr) == "" {
			return nil, fmt.Errorf("No ASR content for video %s. Run ASR first.", f.UploadUUID)
		}
		return &Parsed{Text: asr, Source: "asr"}, nil
	}
	if IsImageFile(f.MimeType, f.OriginalName) {
		return e.ocrImage(ctx, f, data)
	}
	parsed, err := Extract(f.MimeType, f.OriginalName, data)
	if err != nil && errors.Is(err, ErrEmptyPDFText) && isPDFFile(f.MimeType, f.OriginalName) {
		return e.ocrScannedPDF(ctx, f, data)
	}
	return parsed, err
}

// ParseDocument runs the file-to-text routing without MinIO or Mongo access:
// video files are rejected (their text comes from the ASR store, which this
// entry point deliberately does not touch), images go through vision OCR,
// image-only PDFs through OCR of their embedded page images, and everything
// else through the text parsers. It exposes the extraction decision for
// black-box tests and future callers; the vectorize pipeline keeps using the
// engine directly.
func ParseDocument(ctx context.Context, ocr *OCRClient, mimeType, filename string, data []byte) (*Parsed, error) {
	e := &Engine{ocr: ocr, extractPDFImages: extractPDFImagesPDFCPU}
	return e.parseDocument(ctx, &model.CloudFile{OriginalName: filename, MimeType: mimeType}, data)
}

// ocrImage runs vision OCR over a single uploaded image.
func (e *Engine) ocrImage(ctx context.Context, f *model.CloudFile, data []byte) (*Parsed, error) {
	if !e.ocr.Enabled() {
		// Same permanent-skip semantics images had before OCR existed.
		return nil, fmt.Errorf("%w: %s", ErrOCRDisabled, f.OriginalName)
	}
	mime := NormalizeImageMime(f.MimeType, data)
	if mime == "" {
		metrics.OCRTotal.WithLabelValues("unsupported").Inc()
		return nil, fmt.Errorf("%w: %q", ErrOCRUnsupportedImage, f.MimeType)
	}
	text, err := e.ocr.Recognize(ctx, OCRImage{Data: data, MimeType: mime})
	if err != nil {
		metrics.OCRTotal.WithLabelValues(ocrResultLabel(err)).Inc()
		return nil, fmt.Errorf("ocr image %s: %w", f.UploadUUID, err)
	}
	metrics.OCRTotal.WithLabelValues("ok").Inc()
	return &Parsed{Text: text, Source: "ocr"}, nil
}

// ocrScannedPDF OCRs the embedded page images of an image-only PDF. Images
// that individually cannot be read are skipped so the readable pages still
// land; any transient gateway failure aborts the run as retryable.
func (e *Engine) ocrScannedPDF(ctx context.Context, f *model.CloudFile, data []byte) (*Parsed, error) {
	if !e.ocr.Enabled() {
		// Keep the pre-OCR permanent skip for scanned PDFs.
		return nil, ErrEmptyPDFText
	}
	extract := e.extractPDFImages
	if extract == nil {
		extract = extractPDFImagesPDFCPU
	}
	images, err := extract(data, e.ocr.MaxPDFPages(), e.ocr.MaxImages(), e.ocr.MaxImageBytes())
	if err != nil {
		slog.Warn("[PIPELINE_OCR] scanned PDF image extraction failed — treated as no extractable content",
			"upload_uuid", f.UploadUUID, "err", err)
		return nil, fmt.Errorf("%w: %v", ErrEmptyPDFText, err)
	}
	if len(images) == 0 {
		return nil, ErrEmptyPDFText
	}
	var b strings.Builder
	recognized := 0
	for _, img := range images {
		text, oerr := e.ocr.Recognize(ctx, OCRImage{Data: img.Data, MimeType: img.MimeType})
		if oerr != nil {
			if IsPermanentOCRError(oerr) {
				// One unusable image must not discard the readable pages.
				metrics.OCRTotal.WithLabelValues("unsupported").Inc()
				continue
			}
			metrics.OCRTotal.WithLabelValues("error").Inc()
			return nil, fmt.Errorf("ocr scanned pdf %s (page %d): %w", f.UploadUUID, img.Page, oerr)
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		recognized++
		b.WriteString(text)
		b.WriteString("\n\n")
	}
	if recognized == 0 {
		metrics.OCRTotal.WithLabelValues("unsupported").Inc()
		return nil, ErrOCRNoContent
	}
	metrics.OCRTotal.WithLabelValues("ok").Inc()
	return &Parsed{Text: strings.TrimSpace(b.String()), Source: "ocr"}, nil
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
