package tests

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"app-content/internal/logger"
)

func TestContextHandlerInjectsRequestID(t *testing.T) {
	var buf bytes.Buffer
	base := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := slog.New(logger.NewContextHandler(base))

	ctx := logger.IntoContext(context.Background(), "req-123")
	l.InfoContext(ctx, "with id")
	if !strings.Contains(buf.String(), "request_id=req-123") {
		t.Fatalf("request id missing from log line: %s", buf.String())
	}

	buf.Reset()
	l.InfoContext(context.Background(), "without id")
	if strings.Contains(buf.String(), "request_id=") {
		t.Fatalf("unexpected request_id on background line: %s", buf.String())
	}
}

func TestFromContextDefault(t *testing.T) {
	if got := logger.FromContext(context.Background()); got != logger.DefaultRequestID {
		t.Fatalf("FromContext = %q, want %q", got, logger.DefaultRequestID)
	}
}

func TestInitWritesRotatingLogFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app-content.log")
	old := slog.Default()
	t.Cleanup(func() {
		_ = logger.Close()
		slog.SetDefault(old)
	})

	logger.Init(logger.Options{Level: "info", Format: "text", Output: "file", File: logger.FileOptions{Path: path, MaxSize: 1, MaxBackups: 1, MaxAge: 1}})
	slog.Info("file sink works", "k", "v")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if !strings.Contains(string(raw), "file sink works") {
		t.Fatalf("log line missing from file: %s", string(raw))
	}
}

func TestInitRespectsLevel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "level.log")
	old := slog.Default()
	t.Cleanup(func() {
		_ = logger.Close()
		slog.SetDefault(old)
	})

	logger.Init(logger.Options{Level: "warn", Format: "text", Output: "file", File: logger.FileOptions{Path: path}})
	slog.Info("should be filtered")
	slog.Warn("should be kept")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if strings.Contains(string(raw), "should be filtered") {
		t.Fatalf("info line leaked at warn level: %s", string(raw))
	}
	if !strings.Contains(string(raw), "should be kept") {
		t.Fatalf("warn line missing: %s", string(raw))
	}
}
