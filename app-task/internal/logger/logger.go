// Package logger provides slog-based structured logging infrastructure for
// app-task. It centralizes:
//   - Init: configurable level (debug/info/warn/error), format (text/json),
//     and output (stdout|file|both) with lumberjack rotation for file mode
//   - GinLogger: HTTP access-log middleware writing to slog (replaces gin.Logger)
//   - GinRecovery: panic-recovery middleware writing to slog (replaces
//     gin.Recovery which writes to stderr)
//   - NewGORMLogger: GORM logger backed by slog via gorm's built-in NewSlogLogger
//
// Service-layer code keeps using slog.Info/Warn/Error directly with [MODULE]
// prefixes; this package only wires infrastructure.
package logger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gopkg.in/natefinch/lumberjack.v2"
	gormlogger "gorm.io/gorm/logger"
)

// Options configures the default slog logger.
type Options struct {
	Level  string      // debug|info|warn|error (default info)
	Format string      // text|json (default text)
	Output string      // stdout|file|both (default stdout)
	File   FileOptions // used when Output is file or both
}

// FileOptions configures lumberjack-based file rotation.
type FileOptions struct {
	Path       string // log file path (default /app/logs/app-task.log)
	MaxSize    int    // max MB per file before rotation (default 100)
	MaxBackups int    // number of old files to keep (default 7)
	MaxAge     int    // max days to retain old files (default 30)
	Compress   bool   // gzip rotated files
}

// Init configures the default slog logger from opts. Call once at startup,
// before db.Init so NewGORMLogger picks up the configured handler via
// slog.Default().
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
	hOpts := &slog.HandlerOptions{Level: lvl}
	var h slog.Handler
	if strings.ToLower(strings.TrimSpace(opts.Format)) == "json" {
		h = slog.NewJSONHandler(w, hOpts)
	} else {
		h = slog.NewTextHandler(w, hOpts)
	}
	slog.SetDefault(slog.New(h))
}

// newWriter selects the log destination(s) based on Output.
func newWriter(opts Options) io.Writer {
	switch strings.ToLower(strings.TrimSpace(opts.Output)) {
	case "file":
		return newFileWriter(opts.File)
	case "both":
		return io.MultiWriter(os.Stdout, newFileWriter(opts.File))
	default: // stdout
		return os.Stdout
	}
}

// newFileWriter builds a lumberjack rotating writer, applying sane defaults
// for any zero field. The directory must exist and be writable (mount a volume
// at Path in docker).
func newFileWriter(f FileOptions) io.Writer {
	if f.Path == "" {
		f.Path = "/app/logs/app-task.log"
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

// GinLogger is a Gin middleware that writes one structured access-log entry per
// request to slog (module=http). Status >=500 -> error, >=400 -> warn, else info.
func GinLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		raw := c.Request.URL.RawQuery

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
		if raw != "" {
			attrs = append(attrs, slog.String("query", raw))
		}
		if len(c.Errors) > 0 {
			attrs = append(attrs, slog.String("err", c.Errors.String()))
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

// GinRecovery recovers panics and logs them via slog (level=error), replacing
// gin.Recovery() which writes to stderr. Always aborts with 500.
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

// NewGORMLogger returns a GORM logger backed by slog via GORM's built-in
// NewSlogLogger adapter. SQL logs share the same handler/destination as the app.
//
//   - debug=true  -> Info level (every query logged)
//   - debug=false -> Warn level (only slow queries >= 200ms + errors)
//
// Call after Init so slog.Default() is the configured handler.
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
