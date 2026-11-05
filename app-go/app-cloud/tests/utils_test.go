package tests

// Shared cloud helpers (internal/utils): the same title and truncation
// behaviour is used by the pipeline, services and storage adapters.

import (
	"strings"
	"testing"
	"unicode/utf8"

	"app-cloud/internal/model"
	"app-cloud/internal/utils"
)

func TestDisplayTitlePrefersUserTitle(t *testing.T) {
	title := "季度报告"
	if got := utils.DisplayTitle(&model.CloudFile{Title: &title, OriginalName: "report.pdf"}); got != title {
		t.Fatalf("display title = %q, want %q", got, title)
	}
	empty := "  "
	if got := utils.DisplayTitle(&model.CloudFile{Title: &empty, OriginalName: "report.pdf"}); got != "report.pdf" {
		t.Fatalf("blank title must fall back to file name, got %q", got)
	}
	if got := utils.DisplayTitle(nil); got != "" {
		t.Fatalf("nil file title = %q", got)
	}
}

func TestTruncateBytesKeepsUTF8Boundary(t *testing.T) {
	long := strings.Repeat("错", 250) // 750 bytes
	got := utils.TruncateBytes(long, 500)
	if len(got) > 500 || !utf8.ValidString(got) {
		t.Fatalf("invalid byte truncation: len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	if !strings.HasPrefix(long, got) {
		t.Fatal("truncated value must be a prefix")
	}
	if got := utils.TruncateBytes("short", 500); got != "short" {
		t.Fatalf("short passthrough = %q", got)
	}
}

func TestTruncateRunesCountsRunes(t *testing.T) {
	if got := utils.TruncateRunes("一二三四五", 2); got != "一二" {
		t.Fatalf("rune truncation = %q", got)
	}
	if got := utils.TruncateRunes("abc", 0); got != "" {
		t.Fatalf("zero limit = %q", got)
	}
}
