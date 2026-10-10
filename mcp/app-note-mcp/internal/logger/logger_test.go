package logger

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// logPath returns a temp-file path for Output=file loggers, so tests can
// assert on emitted lines without touching process std streams. No cleanup:
// lumberjack keeps the handle open for the life of the test process, and a
// Windows t.TempDir RemoveAll would fail on the open handle.
func logPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "boardmcp-log-test")
	if err != nil {
		t.Fatalf("mktemp: %v", err)
	}
	return filepath.Join(dir, "test.log")
}

func readAll(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	return string(data)
}

func TestLevelFilter(t *testing.T) {
	path := logPath(t)
	lg := New(Options{Level: "info", Format: "json", Output: "file", File: FileOptions{Path: path}})
	lg.Debug("hidden", "k", "v")
	lg.Info("visible")

	out := readAll(t, path)
	if strings.Contains(out, "hidden") {
		t.Errorf("debug line must be filtered at info level: %s", out)
	}
	if !strings.Contains(out, "visible") {
		t.Errorf("info line missing: %s", out)
	}
}

func TestJSONShapeAndRequestIDInjection(t *testing.T) {
	path := logPath(t)
	lg := New(Options{Level: "info", Format: "json", Output: "file", File: FileOptions{Path: path}})

	ctx := IntoContext(context.Background(), "trace-42")
	lg.InfoContext(ctx, "tool call", "tool", "list_boards")

	line := strings.TrimSpace(readAll(t, path))
	var rec map[string]any
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		t.Fatalf("line is not JSON: %s", line)
	}
	if rec["msg"] != "tool call" || rec["tool"] != "list_boards" {
		t.Errorf("unexpected record: %s", line)
	}
	if rec["request_id"] != "trace-42" {
		t.Errorf("request_id not injected from ctx: %s", line)
	}
}

func TestRequestIDOmittedWithoutContext(t *testing.T) {
	path := logPath(t)
	lg := New(Options{Level: "info", Format: "json", Output: "file", File: FileOptions{Path: path}})
	lg.Info("no scope")

	out := readAll(t, path)
	if strings.Contains(out, "request_id") {
		t.Errorf("background log must not carry request_id: %s", out)
	}
	if FromContext(context.Background()) != DefaultRequestID {
		t.Errorf("FromContext default = %q, want %q", FromContext(context.Background()), DefaultRequestID)
	}
}

func TestTextFormat(t *testing.T) {
	path := logPath(t)
	lg := New(Options{Level: "info", Format: "text", Output: "file", File: FileOptions{Path: path}})
	lg.Warn("plain", "k", "v")

	out := readAll(t, path)
	if !strings.Contains(out, `level=WARN msg=plain k=v`) {
		t.Errorf("text format line missing: %s", out)
	}
}

func TestGuardStdioOutput(t *testing.T) {
	for _, unsafe := range []string{"stdout", "BOTH", " both "} {
		if !GuardStdioOutput(unsafe) {
			t.Errorf("GuardStdioOutput(%q) = false, want true", unsafe)
		}
	}
	for _, safe := range []string{"stderr", "file", "", "anything"} {
		if GuardStdioOutput(safe) {
			t.Errorf("GuardStdioOutput(%q) = true, want false", safe)
		}
	}
}

func TestFileRotationDefaultsApplied(t *testing.T) {
	path := logPath(t)
	lg := New(Options{Level: "info", Format: "json", Output: "file", File: FileOptions{Path: path}})
	lg.Info("defaults")
	// Only assert the write landed; rotation thresholds are lumberjack's own
	// behavior and are exercised by the container smoke test.
	if !strings.Contains(readAll(t, path), "defaults") {
		t.Error("line missing from file")
	}
}
