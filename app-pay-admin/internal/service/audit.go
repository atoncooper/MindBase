// Package service: JSONL audit trail for money-touching operations.
//
// This service writes to the pay domain directly (no Java involvement), which
// bypasses app-pay's PayAuditLogger. To keep the fund-operation audit trail
// intact every money-touching mutation is ALSO appended here as one JSON line,
// mirroring app-pay's pay-audit.jsonl convention (event/ts/kv, rotated via
// lumberjack). Write failures never abort the business request — the DB-level
// pay_membership_event row remains the authoritative audit record — but they
// are logged loudly.
package service

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Audit appends one JSON object per line to the audit file.
type Audit struct {
	mu sync.Mutex
	w  *lumberjack.Logger
}

// NewAudit opens (lazily, via lumberjack) the audit sink at path. Retention is
// deliberately long (365 days) to match app-pay's fund-audit convention.
func NewAudit(path string) *Audit {
	if path == "" {
		path = "/app/logs/pay-admin-audit.jsonl"
	}
	// lumberjack requires the parent directory to exist (local dev uses a
	// relative path like logs/... which may not exist yet).
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Warn("[AUDIT] create audit dir failed", "dir", dir, "err", err)
		}
	}
	return &Audit{w: &lumberjack.Logger{
		Filename:   path,
		MaxSize:    100,
		MaxBackups: 10,
		MaxAge:     365,
		Compress:   true,
	}}
}

// Close flushes and closes the underlying audit file (graceful shutdown /
// test cleanup; Windows cannot delete an open file).
func (a *Audit) Close() error {
	if a.w == nil {
		return nil
	}
	return a.w.Close()
}

// Log appends one audit entry: {"event": ..., "ts": ..., <kv pairs>}.
// kv must be key,value alternates; non-string keys are skipped.
// ts is UTC RFC3339Nano (app-pay's JSONL uses Instant, also UTC).
func (a *Audit) Log(event string, kv ...any) {
	entry := map[string]any{
		"event": event,
		"ts":    time.Now().UTC().Format(time.RFC3339Nano),
	}
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			continue
		}
		entry[key] = kv[i+1]
	}
	b, err := json.Marshal(entry)
	if err != nil {
		slog.Error("[AUDIT] marshal failed", "event", event, "err", err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := a.w.Write(append(b, '\n')); err != nil {
		slog.Error("[AUDIT] write failed", "event", event, "err", err)
	}
}
