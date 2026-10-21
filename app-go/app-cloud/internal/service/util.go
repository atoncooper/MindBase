package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"app-cloud/internal/metrics"
	"app-cloud/internal/model"
	"app-cloud/internal/infra/mongostore"
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

// VectorEngine — the port the pipeline service drives (implemented by
// internal/pipeline.Engine via structural typing). Keeping the port here
// keeps the service package free of the milvus dependency.
type VectorEngine interface {
	Vectorize(ctx context.Context, f *model.CloudFile, hooks pipeline.VectorizeHooks) (int, error)
	CountChunks(ctx context.Context, uploadUUID string) (int, error)
	DeleteChunks(ctx context.Context, uploadUUID string) error
}

// CloudGraphWriter — the port for L1 routing-graph writes (implemented by
// KgClient; nil = graph writes disabled).
type CloudGraphWriter interface {
	Enabled() bool
	UpsertCloudDocGraph(ctx context.Context, uid int64, uploadUUID, title, contentHash string, topics, entities []string) error
	DeleteCloudDocGraph(ctx context.Context, uid int64, uploadUUID string) error
}

// Admission-control rejections (capacity layer) — the router maps both to
// HTTP 429. Chinese text here is USER-FACING wire detail, not a comment.
var ErrTooManyUserTasks = errors.New("该账号排队中的向量化任务已达上限，请等待完成后再试")
var ErrQueueFull = errors.New("系统排队繁忙，当前任务较多，请稍后再试")

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
	tasks   *repo.VectorTaskRepo
	mongo   *mongostore.MongoStore
	rdb     RedisPublisher
	channel string
	engine  VectorEngine // nil = pipeline disabled
	quota   *QuotaService // tier resolution for claim priority (nil → FIFO)
	summary *Summarizer   // L1 summary generator (nil-safe via Enabled)
	kg      *KgClient     // L1 routing-graph writer (nil-safe via Enabled)

	// claim priority + elastic worker pool state
	workersMu  sync.Mutex
	curWorkers int
	autoscale  bool
	minWorkers int
	maxWorkers int

	// admission control caps (0 = check disabled)
	admissionMaxPerUID int64
	admissionMaxQueue  int64

	// Durable task queue (workerpool.go): a fixed worker pool drains
	// cloud_vector_tasks; wake nudges idle workers, stop shuts them down.
	startOnce sync.Once
	stopOnce  sync.Once
	wg        sync.WaitGroup
	wake      chan struct{}
	stop      chan struct{}
	workerID  string
}

func NewPipeline(db *gorm.DB, mongo *mongostore.MongoStore, rdb RedisPublisher, channel string,
	quota *QuotaService, summary *Summarizer, kg *KgClient, admissionMaxPerUID, admissionMaxQueue int64) *Pipeline {
	hostname, _ := os.Hostname()
	return &Pipeline{
		db: db, files: repo.NewFileRepo(), tasks: repo.NewVectorTaskRepo(),
		mongo: mongo, rdb: rdb, channel: channel,
		quota:              quota,
		summary:            summary,
		kg:                 kg,
		admissionMaxPerUID: admissionMaxPerUID,
		admissionMaxQueue:  admissionMaxQueue,
		wake:     make(chan struct{}, 1),
		stop:     make(chan struct{}),
		workerID: fmt.Sprintf("%s-%d", hostname, os.Getpid()),
	}
}

// tierStatus maps the membership tier to a claim priority. Unknown/free →
// pending_low (fail-closed, consistent with the quota stance); paid tiers →
// pending. Priority is FIFO within a tier.
func (p *Pipeline) tierStatus(uid int64) string {
	if p.quota == nil {
		return "pending"
	}
	tier, _ := p.quota.TierFor(context.Background(), uid)
	if tier == "free" {
		return "pending_low"
	}
	return "pending"
}

// SetEngine attaches the vector engine (nil disables the pipeline).
func (p *Pipeline) SetEngine(e VectorEngine) { p.engine = e }

// pipelineTimeout bounds one full pipeline run (download → extract → embed
// → Milvus). Without it a half-open MinIO/Mongo/Milvus connection leaves the
// row in "processing" forever.
const pipelineTimeout = 5 * time.Minute

// docDisplayTitle — the title used for summaries, embedding prefixes and
// graph nodes (user-set title wins over the original file name).
func docDisplayTitle(f *model.CloudFile) string {
	if f.Title != nil && strings.TrimSpace(*f.Title) != "" {
		return *f.Title
	}
	return f.OriginalName
}

// staleProcessingAfter is how long a row may sit in "processing" before the
// status endpoint reconciles it to failed (crash / panic / hang guard). Must
// comfortably exceed pipelineTimeout.
const staleProcessingAfter = 10 * time.Minute

// Trigger marks the file pending and enqueues the durable pipeline task; the
// bounded worker pool (workerpool.go) picks it up and the HTTP response
// returns immediately. The task row survives restarts — it IS the queue.
func (p *Pipeline) Trigger(ctx context.Context, uploadUUID string, uid int64) error {
	f, err := p.files.GetByUUID(p.db, uploadUUID, uid)
	if err != nil {
		return err
	}
	if f == nil {
		return ErrNotFound
	}
	// Admission control (capacity layer): cap per-user in-flight work and the
	// global backlog BEFORE accepting the task — a burst sheds load as 429s
	// instead of starving the LLM/embedding gateways behind the workers.
	if p.admissionMaxPerUID > 0 {
		if n, err := p.tasks.CountInFlightForUID(p.db, uid); err == nil && n >= p.admissionMaxPerUID {
			return ErrTooManyUserTasks
		}
	}
	if p.admissionMaxQueue > 0 {
		pending, low, processing, err := p.tasks.CountStates(p.db)
		if err == nil && pending+low+processing >= p.admissionMaxQueue {
			return ErrQueueFull
		}
	}
	// Mark pending; the claiming worker moves it to processing and pushes the
	// WS status, so states stay truthful while the task waits in the queue.
	if err := p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "pending"}); err != nil {
		return err
	}
	return p.EnqueueTask(ctx, uploadUUID, uid)
}

// Reprocess re-runs the pipeline for one file. The HTTP path is ENQUEUE-ONLY
// (peak-shaving contract: no downstream calls in the request handler) — stale
// vectors are removed by the worker itself (delete-before-write inside
// Vectorize), so nothing here touches Milvus.
func (p *Pipeline) Reprocess(ctx context.Context, uploadUUID string, uid int64) (string, error) {
	f, err := p.files.GetByUUID(p.db, uploadUUID, uid)
	if err != nil {
		return "", err
	}
	if f == nil {
		return "", ErrNotFound
	}
	taskID := uploadUUID + ":" + time.Now().Format("20060102150405")
	// reset to pending so RunSync re-runs despite idempotency hash
	if err := p.files.UpdateMeta(p.db, uploadUUID, uid,
		map[string]any{"vector_status": "pending"}); err != nil {
		return "", err
	}
	if err := p.EnqueueTask(ctx, uploadUUID, uid); err != nil {
		return "", err
	}
	return taskID, nil
}

// RunSync executes the pipeline synchronously: idempotency → engine →
// consistency check → done/failed. Returns the chunk count.
func (p *Pipeline) RunSync(ctx context.Context, f *model.CloudFile) (int, error) {
	uid := f.UID
	uploadUUID := f.UploadUUID
	slog.Info("[CLOUD_PIPELINE] run start", "upload_uuid", uploadUUID,
		"vectorizable", f.Vectorizable, "engine", p.engine != nil)

	ctx, cancel := context.WithTimeout(ctx, pipelineTimeout)
	defer cancel()

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

	// L1 summary + routing-graph writes ride the same run via the hook point
	// (best-effort: failures are logged and never block vectorization).
	hooks := pipeline.VectorizeHooks{}
	if p.summary.Enabled() {
		hooks.AfterExtract = func(ctx context.Context, f *model.CloudFile, text, contentHash string) {
			sum, serr := p.summary.Summarize(ctx, docDisplayTitle(f), text)
			if serr != nil {
				slog.Warn("[PIPELINE] summary failed — skipping (non-fatal)", "upload_uuid", f.UploadUUID, "err", serr)
				metrics.SummaryTotal.WithLabelValues("error").Inc()
				return
			}
			sum.SizeChars = utf8.RuneCountInString(text)
			if uerr := p.mongo.UpsertSummary(ctx, f.UploadUUID, f.UID, contentHash, p.summary.ModelName(), sum); uerr != nil {
				slog.Warn("[PIPELINE] summary persist failed — skipping (non-fatal)", "upload_uuid", f.UploadUUID, "err", uerr)
				metrics.SummaryTotal.WithLabelValues("error").Inc()
				return
			}
			metrics.SummaryTotal.WithLabelValues("ok").Inc()
			if p.kg.Enabled() {
				if gerr := p.kg.UpsertCloudDocGraph(ctx, f.UID, f.UploadUUID, docDisplayTitle(f), contentHash, sum.Topics, sum.Entities); gerr != nil {
					slog.Warn("[PIPELINE] kg graph write failed — skipping (non-fatal)", "upload_uuid", f.UploadUUID, "err", gerr)
					metrics.KgWriteTotal.WithLabelValues("error").Inc()
					return
				}
				metrics.KgWriteTotal.WithLabelValues("ok").Inc()
			} else {
				metrics.KgWriteTotal.WithLabelValues("skipped").Inc()
			}
		}
	} else {
		metrics.SummaryTotal.WithLabelValues("skipped").Inc()
	}
	count, err := p.engine.Vectorize(ctx, f, hooks)
	if err != nil {
		// Permanent skips map to not_supported + vectorizable=false so they
		// stop re-entering the pipeline — parity with the Python
		// _NotSupportedDocError handling: encrypted/scanned/image-only docs,
		// types without a parser, oversized documents and decompression-limit
		// hits can never succeed on a retry.
		if errors.Is(err, pipeline.ErrEncryptedPDF) || errors.Is(err, pipeline.ErrEmptyPDFText) ||
			errors.Is(err, pipeline.ErrNoParser) || errors.Is(err, pipeline.ErrDocTooLarge) ||
			errors.Is(err, pipeline.ErrZipEntryTooLarge) {
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
	if ctx.Err() != nil {
		// The pipeline ctx may already be dead (timeout) — the terminal
		// status push must still go out.
		ctx = context.Background()
	}
	payload, _ := json.Marshal(map[string]any{
		"uid": uid, "upload_uuid": uploadUUID, "status": status,
		"chunk_count": count, "error": errMsg, "ts": time.Now().Unix(),
	})
	_ = p.rdb.Publish(ctx, p.channel, payload)
}

// ReconcileStaleProcessing flips a row stuck in "processing" (crash, panic,
// restart mid-run) to failed once it exceeds staleProcessingAfter, so the
// user can retry instead of staring at an endless spinner. Mutates f in
// place to reflect the new status.
func (p *Pipeline) ReconcileStaleProcessing(f *model.CloudFile) {
	if f.VectorStatus == nil || *f.VectorStatus != "processing" {
		return
	}
	if f.UpdatedAt == nil || time.Since(*f.UpdatedAt) < staleProcessingAfter {
		return
	}
	if err := p.files.UpdateMeta(p.db, f.UploadUUID, f.UID,
		map[string]any{"vector_status": "failed"}); err != nil {
		return
	}
	// Close the outbox row too, or the janitor would resurrect a task the
	// user has already been told failed. The message doubles as the marker
	// the failed-retry query excludes on.
	_ = p.tasks.FinishByUploadUUID(p.db, f.UploadUUID, "failed", repo.StaleReconciledMsg)
	slog.Warn("[CLOUD_PIPELINE] stale processing reconciled to failed",
		"upload_uuid", f.UploadUUID, "age", time.Since(*f.UpdatedAt).Round(time.Second))
	failed := "failed"
	f.VectorStatus = &failed
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
