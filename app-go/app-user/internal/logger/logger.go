// Package logger provides slog-based structured logging infrastructure for
// app-note (level/format/output wiring, Gin access log + recovery, GORM slog
// adapter). Same conventions as the other Go services in this repo.
package logger

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	gormlogger "gorm.io/gorm/logger"
)

// Options configures the default slog logger.
type Options struct {
	Level  string      // debug|info|warn|error (default info)
	Format string      // text|json (default text)
	Output string      // stdout|file|both (default stdout)
	File   FileOptions // used when Output is file or both

	AddSource  bool
	RedactKeys []string
	Sampling   SamplingOptions
	Async      AsyncOptions
}

type SamplingOptions struct {
	Enabled    bool
	Initial    int
	Thereafter int
}

type AsyncOptions struct {
	Enabled      bool
	Buffer       int
	DropWhenFull bool
}

// FileOptions configures lumberjack-based file rotation.
type FileOptions struct {
	Path              string
	MaxSize           int // MB per file
	MaxBackups        int
	MaxAge            int // days
	Compress          bool
	CompressAlgorithm string // gzip|zstd
	CompressLevel     int    // gzip 1-9 / zstd 1-19
	CompressQueue     int    // archive compression queue depth
	MaxTotalSize      int    // MB total archives (0 = unlimited)
}

// Init configures the default slog logger. Call once at startup, before
// db.Init so the GORM logger picks up the configured handler.
func Init(opts Options) {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(opts.Level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	w := newWriter(opts)
	hOpts := &slog.HandlerOptions{Level: lvl, AddSource: opts.AddSource}
	var h slog.Handler
	if strings.ToLower(strings.TrimSpace(opts.Format)) == "json" {
		h = slog.NewJSONHandler(w, hOpts)
	} else {
		h = slog.NewTextHandler(w, hOpts)
	}
	h = newRedactHandler(h, opts.RedactKeys)
	if opts.Sampling.Enabled {
		h = newSamplingHandler(h, opts.Sampling)
	}
	slog.SetDefault(slog.New(h))
}

func newWriter(opts Options) io.Writer {
	var w io.Writer
	switch strings.ToLower(strings.TrimSpace(opts.Output)) {
	case "file":
		w = newFileWriter(opts.File)
	case "both":
		w = io.MultiWriter(os.Stdout, newFileWriter(opts.File))
	default:
		w = os.Stdout
	}
	if opts.Async.Enabled {
		return newAsyncWriter(w, opts.Async)
	}
	return w
}

var activeFile *rotatingWriter

func newFileWriter(f FileOptions) io.Writer {
	activeFile = newRotatingWriter(f)
	return activeFile
}

// sensitiveQueryKeys lists query parameters whose values must never reach the
// access log: credentials and one-time tokens (login/2FA/reset/oauth/email).
var sensitiveQueryKeys = map[string]struct{}{
	"token":        {},
	"access_token": {},
	"reset_token":  {},
	"code":         {},
	"ticket":       {},
	"password":     {},
}

// redactQuery parses the raw query string, replaces the values of sensitive
// parameters with "***", and re-encodes it. Other parameters are preserved
// verbatim (values are re-encoded by url.Values.Encode). Returns "" for an
// empty query so callers can skip the attribute entirely; malformed encoding
// is masked wholesale rather than echoed.
func redactQuery(raw string) string {
	if raw == "" {
		return ""
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "***"
	}
	for key := range values {
		if _, ok := sensitiveQueryKeys[strings.ToLower(key)]; !ok {
			continue
		}
		for i := range values[key] {
			values[key][i] = "***"
		}
	}
	return values.Encode()
}

// Access log runtime options (configured from server.access_log_* YAML).
var accessLogEnabled atomic.Bool
var accessLogSample atomic.Int64
var accessLogFormat atomic.Value
var accessLogSeq atomic.Uint64

func init() {
	accessLogEnabled.Store(true)
	accessLogSample.Store(100)
	accessLogFormat.Store("slog")
}

// ConfigureAccessLog applies sampling/format at startup. sampleRate is a
// percentage (0-100); format is "slog" (structured) or "text".
func ConfigureAccessLog(enabled bool, sampleRate int, format string) {
	accessLogEnabled.Store(enabled)
	if sampleRate < 0 {
		sampleRate = 0
	}
	if sampleRate > 100 {
		sampleRate = 100
	}
	accessLogSample.Store(int64(sampleRate))
	if f := strings.ToLower(strings.TrimSpace(format)); f != "" {
		accessLogFormat.Store(f)
	}
}

// GinLogger writes one structured access-log entry per request. Status >=500
// -> error, >=400 -> warn, else info.
func GinLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !accessLogEnabled.Load() {
			c.Next()
			return
		}
		if rate := accessLogSample.Load(); rate < 100 {
			seq := accessLogSeq.Add(1)
			if int64(seq%100) >= rate {
				c.Next()
				return
			}
		}
		start := time.Now()
		path := c.Request.URL.Path
		raw := redactQuery(c.Request.URL.RawQuery)

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		attrs := []slog.Attr{
			slog.String("module", "http"),
			slog.String("method", c.Request.Method),
			slog.String("path", path),
			slog.Int("status", status),
			slog.Int("size", c.Writer.Size()),
			slog.Duration("latency", latency),
			slog.String("ip", c.ClientIP()),
		}
		// Gateway request-id correlation (set by the router's requestID
		// middleware — APISIX request-id plugin header or a minted uuid).
		if id := c.GetString("request_id"); id != "" {
			attrs = append(attrs, slog.String("request_id", id))
		}
		if raw != "" {
			attrs = append(attrs, slog.String("query", raw))
		}

		if f, _ := accessLogFormat.Load().(string); f == "text" {
			slog.Info(fmt.Sprintf("http %s %s status=%d size=%d latency=%s ip=%s",
				c.Request.Method, path, status, c.Writer.Size(), latency, c.ClientIP()))
			return
		}
		ctx := context.Background()
		msg := "http request"
		switch {
		case status >= 500:
			slog.LogAttrs(ctx, slog.LevelError, msg, attrs...)
		case status >= 400:
			slog.LogAttrs(ctx, slog.LevelWarn, msg, attrs...)
		default:
			slog.LogAttrs(ctx, slog.LevelInfo, msg, attrs...)
		}
	}
}

// GinRecovery recovers panics and logs them via slog (level=error).
func GinRecovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("[HTTP] panic recovered",
					"error", rec,
					"method", c.Request.Method,
					"path", c.Request.URL.Path,
				)
				c.AbortWithStatus(500)
			}
		}()
		c.Next()
	}
}

// NewGORMLogger returns a GORM logger backed by slog. debug=true logs every
// query; otherwise only slow (>=200ms) queries and errors.
func NewGORMLogger(debug bool) gormlogger.Interface {
	lvl := gormlogger.Warn
	if debug {
		lvl = gormlogger.Info
	}
	return gormlogger.NewSlogLogger(slog.Default(), gormlogger.Config{
		SlowThreshold: 200 * time.Millisecond,
		LogLevel:      lvl,
		Colorful:      false,
	})
}

// ── redaction ────────────────────────────────────────────────────────────

type redactHandler struct {
	next   slog.Handler
	keys   map[string]struct{}
	attrs  []slog.Attr
	groups []string
}

func newRedactHandler(next slog.Handler, keys []string) slog.Handler {
	if len(keys) == 0 {
		keys = []string{"password", "token", "secret", "api_key", "apikey", "authorization", "cookie", "access_key", "access_key_secret", "sms_code", "refresh_token"}
	}
	m := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		m[strings.ToLower(strings.TrimSpace(k))] = struct{}{}
	}
	return &redactHandler{next: next, keys: m}
}

func (h *redactHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *redactHandler) Handle(ctx context.Context, r slog.Record) error {
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	for _, a := range h.attrs {
		out.AddAttrs(redactAttr(h.keys, a))
	}
	r.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(redactAttr(h.keys, a))
		return true
	})
	return h.next.Handle(ctx, out)
}

func (h *redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := h.next.WithAttrs(redactAttrs(h.keys, attrs))
	return &redactHandler{next: next, keys: h.keys, attrs: h.attrs, groups: h.groups}
}

func (h *redactHandler) WithGroup(name string) slog.Handler {
	return &redactHandler{next: h.next.WithGroup(name), keys: h.keys, attrs: h.attrs}
}

func redactAttrs(keys map[string]struct{}, attrs []slog.Attr) []slog.Attr {
	out := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		out = append(out, redactAttr(keys, a))
	}
	return out
}

func redactAttr(keys map[string]struct{}, a slog.Attr) slog.Attr {
	if a.Value.Kind() == slog.KindGroup {
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(redactAttrs(keys, a.Value.Group())...)}
	}
	if _, ok := keys[strings.ToLower(a.Key)]; ok {
		return slog.String(a.Key, "***")
	}
	return a
}

// ── sampling ─────────────────────────────────────────────────────────────

type samplingHandler struct {
	next   slog.Handler
	opts   SamplingOptions
	mu     *sync.Mutex
	seen   map[string]uint64
	attrs  []slog.Attr
	groups []string
}

func newSamplingHandler(next slog.Handler, opts SamplingOptions) slog.Handler {
	if opts.Initial <= 0 {
		opts.Initial = 5
	}
	if opts.Thereafter <= 0 {
		opts.Thereafter = 100
	}
	return &samplingHandler{next: next, opts: opts, mu: &sync.Mutex{}, seen: map[string]uint64{}}
}

func (h *samplingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *samplingHandler) Handle(ctx context.Context, r slog.Record) error {
	key := r.Level.String() + "|" + r.Message
	h.mu.Lock()
	n := h.seen[key]
	h.seen[key] = n + 1
	h.mu.Unlock()
	if n >= uint64(h.opts.Initial) && (n-uint64(h.opts.Initial))%uint64(h.opts.Thereafter) != 0 {
		return nil
	}
	if len(h.attrs) > 0 {
		r.AddAttrs(h.attrs...)
	}
	return h.next.Handle(ctx, r)
}

func (h *samplingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &samplingHandler{next: h.next, opts: h.opts, mu: h.mu, seen: h.seen, attrs: append(append([]slog.Attr{}, h.attrs...), attrs...)}
}

func (h *samplingHandler) WithGroup(name string) slog.Handler {
	return &samplingHandler{next: h.next.WithGroup(name), opts: h.opts, mu: h.mu, seen: h.seen, attrs: h.attrs}
}

// ── async writer ─────────────────────────────────────────────────────────

type asyncWriter struct {
	dst    io.Writer
	ch     chan []byte
	done   chan struct{}
	drop   bool
	closed sync.Once
}

var activeAsync *asyncWriter

func newAsyncWriter(dst io.Writer, opts AsyncOptions) io.Writer {
	if opts.Buffer <= 0 {
		opts.Buffer = 4096
	}
	aw := &asyncWriter{dst: dst, ch: make(chan []byte, opts.Buffer), done: make(chan struct{}), drop: opts.DropWhenFull}
	activeAsync = aw
	go func() {
		defer close(aw.done)
		for b := range aw.ch {
			_, _ = aw.dst.Write(b)
		}
	}()
	return aw
}

func (w *asyncWriter) Write(p []byte) (int, error) {
	b := append([]byte(nil), p...)
	if w.drop {
		select {
		case w.ch <- b:
		default:
		}
		return len(p), nil
	}
	w.ch <- b
	return len(p), nil
}

// Close flushes the async writer (if enabled). Call before process exit.
func Close() {
	if activeAsync != nil {
		activeAsync.closed.Do(func() { close(activeAsync.ch) })
		<-activeAsync.done
		activeAsync = nil
	}
	if activeFile != nil {
		_ = activeFile.Close()
		activeFile = nil
	}
}
