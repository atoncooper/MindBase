// Package logger provides slog-based structured logging for app-board-mcp,
// mirroring app-board's internal/logger conventions (same env keys, same
// request-id context injection), with one transport-driven difference: the
// default sink is STDERR because in stdio mode stdout is the MCP JSON-RPC
// channel and any stray write there corrupts the protocol.
//
// Service code logs via slog.*Context with [BOARDMCP] message prefixes; this
// package only wires the destination and the request_id context handler.
package logger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Options configures the slog logger.
type Options struct {
	Level  string      // debug|info|warn|error (default info)
	Format string      // text|json (default json)
	Output string      // stderr|stdout|file|both (default stderr; both = stdout+file)
	File   FileOptions // used when Output is file or both
}

// FileOptions configures lumberjack-based file rotation.
type FileOptions struct {
	Path       string // log file path (default /app/logs/app-board-mcp.log)
	MaxSize    int    // max MB per file before rotation (default 100)
	MaxBackups int    // number of old files to keep (default 7)
	MaxAge     int    // max days to retain old files (default 30)
	Compress   bool   // gzip rotated files
}

// New builds the configured slog logger. Main installs it via slog.SetDefault
// so every slog.*Context call across the server shares one sink and one
// request-id context handler.
func New(opts Options) *slog.Logger {
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

	hOpts := &slog.HandlerOptions{Level: lvl}
	var h slog.Handler
	if strings.ToLower(strings.TrimSpace(opts.Format)) == "text" {
		h = slog.NewTextHandler(newWriter(opts), hOpts)
	} else {
		h = slog.NewJSONHandler(newWriter(opts), hOpts)
	}
	// Inject request_id from ctx into every line (see context.go): code that
	// logs via slog.*Context(ctx, …) inside a request automatically gets it.
	h = NewContextHandler(h)
	return slog.New(h)
}

// newWriter selects the log destination(s) based on Output. Both means
// stdout+file (mirrors app-board); stderr is the default so stdio transport
// can never be polluted by logs.
func newWriter(opts Options) io.Writer {
	switch strings.ToLower(strings.TrimSpace(opts.Output)) {
	case "stdout":
		return os.Stdout
	case "file":
		return newFileWriter(opts.File)
	case "both":
		return io.MultiWriter(os.Stdout, newFileWriter(opts.File))
	default: // stderr
		return os.Stderr
	}
}

// newFileWriter builds a lumberjack rotating writer, applying sane defaults
// for any zero field. The directory must exist and be writable by the process
// user (the Dockerfile pre-creates /app/logs owned by nonroot; a mounted
// volume inherits that ownership on first use).
func newFileWriter(f FileOptions) io.Writer {
	if f.Path == "" {
		f.Path = "/app/logs/app-board-mcp.log"
	}
	if f.MaxSize == 0 {
		f.MaxSize = 100
	}
	if f.MaxBackups == 0 {
		f.MaxBackups = 7
	}
	if f.MaxAge == 0 {
		f.MaxAge = 30
	}
	return &lumberjack.Logger{
		Filename:   f.Path,
		MaxSize:    f.MaxSize,
		MaxBackups: f.MaxBackups,
		MaxAge:     f.MaxAge,
		Compress:   f.Compress,
	}
}

// GuardStdioOutput reports whether an output choice is unsafe for the stdio
// transport (stdout is the JSON-RPC channel) along with the safe fallback.
func GuardStdioOutput(output string) (unsafe bool) {
	switch strings.ToLower(strings.TrimSpace(output)) {
	case "stdout", "both":
		return true
	default:
		return false
	}
}

// contextKey unexported: only this package can attach/read the request id.
type contextKey struct{}

// DefaultRequestID is logged when no request id is in scope.
const DefaultRequestID = "-"

// IntoContext attaches the request id to ctx.
func IntoContext(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, contextKey{}, requestID)
}

// FromContext returns the request id in ctx ("-" when absent).
func FromContext(ctx context.Context) string {
	if v, ok := ctx.Value(contextKey{}).(string); ok && v != "" {
		return v
	}
	return DefaultRequestID
}

// contextHandler injects the request_id attr from ctx into every record.
type contextHandler struct {
	slog.Handler
}

func (h *contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := FromContext(ctx); id != DefaultRequestID {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

// NewContextHandler wraps h so every emitted line carries the request id.
func NewContextHandler(h slog.Handler) slog.Handler {
	return &contextHandler{Handler: h}
}
