package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/model"
	"app-cloud/internal/mongostore"
	"app-cloud/internal/pipeline"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// RedisPublisher is the minimal Redis publish surface (decouples tests).
type RedisPublisher interface {
	Publish(ctx context.Context, channel string, message any) error
}

// ErrNotFound maps to HTTP 404 at the router layer.
var ErrNotFound = errors.New("not found")

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func sha256Sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func base64URLEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// urlEscape applies RFC3986 percent-encoding (Content-Disposition filename*).
func urlEscape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '.' || c == '_' || c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xF])
		}
	}
	return b.String()
}

// Pipeline is the C3 hook point: full parse→chunk→embed→vectorize engine.
// The status machine, idempotency and consistency checks live here; the
// actual engine (extractors + Milvus) is attached via SetEngine — when no
// engine is configured the trigger marks files not_supported (pipeline off).
type Pipeline struct {
	db      *gorm.DB
	files   *repo.FileRepo
	mongo   *mongostore.MongoStore
	rdb     RedisPublisher
	channel string
	engine  pipeline.VectorEngine // nil = pipeline disabled
}

func NewPipeline(db *gorm.DB, mongo *mongostore.MongoStore, rdb RedisPublisher, channel string) *Pipeline {
	return &Pipeline{db: db, files: repo.NewFileRepo(), mongo: mongo, rdb: rdb, channel: channel}
}

// SetEngine attaches the vector engine (nil disables the pipeline).
func (p *Pipeline) SetEngine(e pipeline.VectorEngine) { p.engine = e }

// Trigger runs the vectorization pipeline for a file (async from the router).
func (p *Pipeline) Trigger(ctx context.Context, uploadUUID string, uid int64) error {
	f, err := p.files.GetByUUID(p.db, uploadUUID, uid)
	if err != nil {
		return err
	}
	if f == nil {
		return ErrNotFound
	}
	// Mark processing + push status; actual work happens in RunSync.
	processing := "processing"
	if err := p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": processing}); err != nil {
		return err
	}
	p.pushStatus(ctx, uid, uploadUUID, "processing", 0, "")
	// Run synchronously in the caller's goroutine (router calls us inside a
	// fire-and-forget goroutine from the upload completion hook, or the
	// process endpoint spawns one).
	_, runErr := p.RunSync(context.Background(), f)
	return runErr
}

// Reprocess deletes existing vectors then re-runs the pipeline.
func (p *Pipeline) Reprocess(ctx context.Context, uploadUUID string, uid int64) (string, error) {
	f, err := p.files.GetByUUID(p.db, uploadUUID, uid)
	if err != nil {
		return "", err
	}
	if f == nil {
		return "", ErrNotFound
	}
	if p.engine != nil {
		_ = p.engine.DeleteChunks(ctx, uploadUUID) // stale chunks must not survive
	}
	taskID := uploadUUID + ":" + time.Now().Format("20060102150405")
	// reset to pending so RunSync re-runs despite idempotency hash
	if err := p.files.UpdateMeta(p.db, uploadUUID, uid,
		map[string]any{"vector_status": "pending"}); err != nil {
		return "", err
	}
	go func() {
		defer recoverLog("reprocess", uploadUUID)
		_, _ = p.RunSync(context.Background(), f)
	}()
	return taskID, nil
}

// RunSync executes the pipeline synchronously: idempotency → engine →
// consistency check → done/failed. Returns the chunk count.
func (p *Pipeline) RunSync(ctx context.Context, f *model.CloudFile) (int, error) {
	uid := f.UID
	uploadUUID := f.UploadUUID
	slog.Info("[CLOUD_PIPELINE] run start", "upload_uuid", uploadUUID,
		"vectorizable", f.Vectorizable, "engine", p.engine != nil)

	if !f.Vectorizable {
		_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "not_supported"})
		p.pushStatus(ctx, uid, uploadUUID, "not_supported", 0, "")
		return 0, nil
	}
	if p.engine == nil {
		_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "not_supported"})
		p.pushStatus(ctx, uid, uploadUUID, "not_supported", 0, "pipeline disabled")
		return 0, nil
	}

	// status → processing
	_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "processing"})
	p.pushStatus(ctx, uid, uploadUUID, "processing", 0, "")

	count, err := p.engine.Vectorize(ctx, f, nil) // engine downloads via MinIO itself
	if err != nil {
		// Permanent skips (encrypted / scanned / image-only docs) map to
		// not_supported + vectorizable=false so they stop re-entering the
		// pipeline — parity with the Python _NotSupportedDocError handling.
		if errors.Is(err, pipeline.ErrEncryptedPDF) || errors.Is(err, pipeline.ErrEmptyPDFText) {
			_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{
				"vectorizable": false, "vector_status": "not_supported",
			})
			p.pushStatus(ctx, uid, uploadUUID, "not_supported", 0, err.Error())
			return 0, nil
		}
		slog.Error("[CLOUD_PIPELINE] vectorize failed", "upload_uuid", uploadUUID, "err", err)
		_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "failed"})
		p.pushStatus(ctx, uid, uploadUUID, "failed", 0, err.Error())
		return 0, err
	}

	// Consistency check: Milvus count must equal the engine's report.
	actual, err := p.engine.CountChunks(ctx, uploadUUID)
	slog.Info("[CLOUD_PIPELINE] consistency check", "upload_uuid", uploadUUID, "expected", count, "actual", actual, "err", err)
	if err != nil || actual != count {
		_ = p.engine.DeleteChunks(ctx, uploadUUID) // roll back orphan vectors
		_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "failed"})
		p.pushStatus(ctx, uid, uploadUUID, "failed", 0, "consistency check failed")
		return 0, errors.New("consistency check failed: milvus count mismatch")
	}

	done := "done"
	_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{
		"vector_status":      done,
		"vector_chunk_count": count,
	})
	p.pushStatus(ctx, uid, uploadUUID, "done", count, "")
	return count, nil
}

// pushStatus publishes a processing-status change to Redis for the backend
// WS bridge (frontend receives it via the existing /ws connection).
func (p *Pipeline) pushStatus(ctx context.Context, uid int64, uploadUUID, status string, count int, errMsg string) {
	if p.rdb == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"uid": uid, "upload_uuid": uploadUUID, "status": status,
		"chunk_count": count, "error": errMsg, "ts": time.Now().Unix(),
	})
	_ = p.rdb.Publish(ctx, p.channel, payload)
}

func recoverLog(op, uploadUUID string) {
	if r := recover(); r != nil {
		logErr("[CLOUD_PIPELINE] panic", op, uploadUUID, r)
	}
}

// DeleteChunks proxies to the engine (purge path; nil-safe).
func (p *Pipeline) DeleteChunks(ctx context.Context, uploadUUID string) error {
	if p.engine == nil {
		return nil
	}
	return p.engine.DeleteChunks(ctx, uploadUUID)
}

// CountChunks proxies to the engine (status endpoint reconcile).
func (p *Pipeline) CountChunks(ctx context.Context, uploadUUID string) (int, error) {
	if p.engine == nil {
		return 0, errors.New("pipeline disabled")
	}
	return p.engine.CountChunks(ctx, uploadUUID)
}

// classifyViewMode — MIME → frontend viewer mode (parity with the Python
// _classify_view_mode; router has its own copy for its responses).
func classifyViewMode(mime string) string {
	m := strings.ToLower(mime)
	switch {
	case strings.HasPrefix(m, "video/"):
		return "video"
	case strings.HasPrefix(m, "audio/"):
		return "audio"
	case strings.HasPrefix(m, "image/"):
		return "image"
	case m == "application/pdf":
		return "pdf"
	case m == "text/html":
		return "html"
	case strings.Contains(m, "markdown") || m == "text/x-markdown":
		return "markdown"
	case strings.HasPrefix(m, "text/") || m == "application/json" ||
		m == "application/xml" || m == "application/javascript" ||
		m == "application/x-yaml":
		return "text"
	default:
		return "unsupported"
	}
}
