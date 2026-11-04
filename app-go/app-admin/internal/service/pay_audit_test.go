package service

// Fund-audit JSONL tests: hash-chain linkage across lines AND across a restart
// (the chain must resume from the last hash, not restart at GENESIS), plus the
// nil-sink guard used when the pay module is disabled.

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPayAuditHashChainAndResume(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pay-audit.jsonl")

	audit := NewPayAudit(path)
	audit.Log("MEMBERSHIP_EXTENDED", "operator", "admin", "uid", "5001", "days", 30)
	audit.Log("REFUND_CONFIRMED", "operator", "admin", "order_no", "PO1")
	if err := audit.Close(); err != nil {
		t.Fatalf("close audit: %v", err)
	}

	lines := readAuditLines(t, path)
	if len(lines) != 2 {
		t.Fatalf("expected 2 audit lines, got %d: %+v", len(lines), lines)
	}
	if lines[0]["prev"] != "GENESIS" {
		t.Fatalf("first line must start at GENESIS, got %v", lines[0]["prev"])
	}
	if lines[0]["chain"] == "" || lines[0]["chain"] != lines[1]["chain"] {
		t.Fatalf("chain id missing/mismatched: %v vs %v", lines[0]["chain"], lines[1]["chain"])
	}
	if lines[1]["prev"] != lines[0]["hash"] {
		t.Fatalf("chain broken: line2.prev=%v line1.hash=%v", lines[1]["prev"], lines[0]["hash"])
	}
	if lines[0]["hash"] == "" || lines[0]["hash"] == lines[1]["hash"] {
		t.Fatal("each line must carry a distinct SHA-256 hash")
	}
	if lines[0]["event"] != "MEMBERSHIP_EXTENDED" || lines[0]["uid"] != "5001" ||
		lines[0]["operator"] != "admin" || lines[0]["ts"] == "" {
		t.Fatalf("audit entry fields: %+v", lines[0])
	}

	// Reopen: the chain resumes from the persisted tail hash.
	resumed := NewPayAudit(path)
	resumed.Log("REFUND_REJECTED", "operator", "admin", "order_no", "PO2")
	if err := resumed.Close(); err != nil {
		t.Fatalf("close resumed audit: %v", err)
	}
	lines = readAuditLines(t, path)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines after resume, got %d", len(lines))
	}
	if lines[2]["prev"] != lines[1]["hash"] {
		t.Fatalf("resume must continue the chain: got prev=%v want %v", lines[2]["prev"], lines[1]["hash"])
	}
}

func TestPayAuditNilSinkIsSafe(t *testing.T) {
	var nilAudit *PayAudit
	nilAudit.Log("NOOP", "k", "v") // must not panic when the pay module is off
	if err := nilAudit.Close(); err != nil {
		t.Fatalf("nil audit close: %v", err)
	}
}

func readAuditLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open audit file: %v", err)
	}
	defer f.Close()
	var out []map[string]any
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatalf("parse audit line %q: %v", line, err)
		}
		out = append(out, entry)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan audit file: %v", err)
	}
	return out
}
