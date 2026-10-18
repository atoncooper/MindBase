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
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Audit appends one JSON object per line to the audit file.
// 防篡改哈希链：每行携带 chain/prev/hash（SHA-256 链），启动从文件尾部
// 续链（跨重启不断链）。多实例同写一个文件时链会分叉，验证器按 chain 分组。
type Audit struct {
	mu      sync.Mutex
	w       *lumberjack.Logger
	prev    string
	resumed bool
	chainID string
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
	return &Audit{chainID: "ch-" + randomSuffix(), w: &lumberjack.Logger{
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
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.resumed {
		a.prev = resumePrevHash(a.w.Filename)
		a.resumed = true
	}
	body, err := json.Marshal(entry)
	if err != nil {
		slog.Error("[AUDIT] marshal failed", "event", event, "err", err)
		return
	}
	hash := sha256Hex(a.prev + "|" + string(body))
	entry["chain"] = a.chainID
	entry["prev"] = a.prev
	entry["hash"] = hash
	a.prev = hash
	body, err = json.Marshal(entry)
	if err != nil {
		slog.Error("[AUDIT] marshal failed", "event", event, "err", err)
		return
	}
	if _, err := a.w.Write(append(body, '\n')); err != nil {
		slog.Error("[AUDIT] write failed", "event", event, "err", err)
	}
}

// resumePrevHash tails the audit file (last 64KB) for the last hash so the
// chain survives restarts. Any failure restarts from GENESIS (loud WARN).
func resumePrevHash(path string) string {
	const genesis = "GENESIS"
	f, err := os.Open(path)
	if err != nil {
		return genesis
	}
	defer f.Close()
	const window = 64 * 1024
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return genesis
	}
	off := st.Size() - window
	if off < 0 {
		off = 0
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil {
		return genesis
	}
	parts := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	for i := len(parts) - 1; i >= 0; i-- {
		line := strings.TrimSpace(parts[i])
		if line == "" {
			continue
		}
		var node struct {
			Hash string `json:"hash"`
		}
		if json.Unmarshal([]byte(line), &node) == nil && node.Hash != "" {
			return node.Hash
		}
	}
	return genesis
}

func sha256Hex(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

func randomSuffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
