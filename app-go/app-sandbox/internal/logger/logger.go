// Package logger provides the slog wiring shared by every Go service in this
// repo: level/format/output (stdout|file|both) plus a lumberjack rotator, Gin
// access-log/recovery middleware and the GORM slog adapter.
package logger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gopkg.in/natefinch/lumberjack.v2"
	gormlogger "gorm.io/gorm/logger"
)

// Options configures the default slog logger.
type Options struct {
	Level     string      // debug|info|warn|error (default info)
	Format    string      // text|json (default text)
	Output    string      // stdout|file|both (default stdout)
	AddSource bool        // include caller file:line (useful outside prod)
	File      FileOptions // used when Output is file or both
}

// FileOptions configures lumberjack-based file rotation.
type FileOptions struct {
	Path       string
	MaxSize    int // MB per file
	MaxBackups int
	MaxAge     int // days
	Compress   bool
}

// Init configures the default slog logger. Call once at startup, before db.Init
// so the GORM logger picks up the configured handler.
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
	slog.SetDefault(slog.New(h))
}

func newWriter(opts Options) io.Writer {
	switch strings.ToLower(strings.TrimSpace(opts.Output)) {
	case "file":
		return newFileWriter(opts.File)
	case "both":
		return io.MultiWriter(os.Stdout, newFileWriter(opts.File))
	default:
		return os.Stdout
	}
}

func newFileWriter(f FileOptions) io.Writer {
	if f.Path == "" {
		f.Path = "/app/logs/app-sandbox.log"
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

// GinLoggerOptions tunes the structured access log.
type GinLoggerOptions struct {
	Enabled   bool
	Slow      time.Duration
	SkipPaths []string
}

// GinLogger writes one structured access-log entry per request. Status >=500 ->
// error, >=400 or slow -> warn, else info. Health/metrics probes are skipped by
// default to keep the log useful.
func GinLogger(options ...GinLoggerOptions) gin.HandlerFunc {
	opt := GinLoggerOptions{Enabled: true}
	if len(options) > 0 {
		opt = options[0]
	}
	skip := make(map[string]bool, len(opt.SkipPaths))
	for _, path := range opt.SkipPaths {
		skip[path] = true
	}
	return func(c *gin.Context) {
		if !opt.Enabled || skip[c.Request.URL.Path] {
			c.Next()
			return
		}
		start := time.Now()
		path := c.Request.URL.Path
		raw := c.Request.URL.RawQuery
		contentLength := c.Request.ContentLength

		c.Next()

		latency := time.Since(start)
		attrs := []slog.Attr{
			slog.String("module", "http"),
			slog.String("method", c.Request.Method),
			slog.String("path", path),
			slog.Int("status", c.Writer.Status()),
			slog.Int("size", c.Writer.Size()),
			slog.Int64("bytes_in", contentLength),
			slog.Duration("latency", latency),
			slog.String("ip", c.ClientIP()),
			slog.String("user_agent", c.Request.UserAgent()),
		}
		if id := c.GetString("request_id"); id != "" {
			attrs = append(attrs, slog.String("request_id", id))
		}
		if raw != "" {
			attrs = append(attrs, slog.String("query", raw))
		}
		if len(c.Errors) > 0 {
			attrs = append(attrs, slog.String("errors", c.Errors.String()))
		}

		ctx := context.Background()
		msg := "http request"
		status := c.Writer.Status()
		switch {
		case status >= 500:
			slog.LogAttrs(ctx, slog.LevelError, msg, attrs...)
		case status >= 400:
			slog.LogAttrs(ctx, slog.LevelWarn, msg, attrs...)
		case opt.Slow > 0 && latency >= opt.Slow:
			slog.LogAttrs(ctx, slog.LevelWarn, "http slow request", attrs...)
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
					"request_id", c.GetString("request_id"),
					"stack", string(debug.Stack()),
				)
				c.AbortWithStatus(500)
			}
		}()
		c.Next()
	}
}

// NewGORMLogger returns a GORM logger backed by slog. debug=true logs every
// query; otherwise only slow (>= slowThresholdMS, default 200ms) queries and errors.
func NewGORMLogger(debug bool, slowThresholdMS ...int) gormlogger.Interface {
	lvl := gormlogger.Warn
	if debug {
		lvl = gormlogger.Info
	}
	slow := 200 * time.Millisecond
	if len(slowThresholdMS) > 0 && slowThresholdMS[0] > 0 {
		slow = time.Duration(slowThresholdMS[0]) * time.Millisecond
	}
	return gormlogger.NewSlogLogger(slog.Default(), gormlogger.Config{
		SlowThreshold: slow,
		LogLevel:      lvl,
		Colorful:      false,
	})
}
