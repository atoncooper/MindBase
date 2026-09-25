// Package logger provides slog-based structured logging infrastructure for
// app-cloud (level/format/output wiring, Gin access log + recovery, GORM slog
// adapter). Same conventions as the other Go services in this repo.
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
	Path       string
	MaxSize    int // MB per file
	MaxBackups int
	MaxAge     int // days
	Compress   bool
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
	hOpts := &slog.HandlerOptions{Level: lvl}
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
		f.Path = "/app/logs/app-cloud.log"
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

// GinLogger writes one structured access-log entry per request. Status >=500
// -> error, >=400 -> warn, else info.
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
