package router

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"app-cloud/internal/model"
	"app-cloud/internal/pipeline"
)

func intPtr(v int) *int { return &v }

func TestPreviewPageRuneSlices(t *testing.T) {
	// 7 runes: 你 好 世 界 a b c
	const text = "你好世界abc"
	cases := []struct {
		name      string
		offset    int
		limit     int
		want      string
		wantTotal int
		wantMore  bool
		wantNext  *int
	}{
		{"first page", 0, 3, "你好世", 7, true, intPtr(3)},
		{"middle page", 3, 3, "界ab", 7, true, intPtr(6)},
		{"last page", 6, 3, "c", 7, false, nil},
		{"whole text", 0, 100, "你好世界abc", 7, false, nil},
		{"tail page", 2, 100, "世界abc", 7, false, nil},
		{"offset at end", 7, 3, "", 7, false, nil},
		{"offset past end", 99, 3, "", 7, false, nil},
		{"negative offset clamps", -5, 2, "你好", 7, true, intPtr(2)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			preview, total, hasMore, next := previewPage(text, tc.offset, tc.limit)
			if preview != tc.want {
				t.Fatalf("preview = %q, want %q", preview, tc.want)
			}
			if total != tc.wantTotal {
				t.Fatalf("totalChars = %d, want %d", total, tc.wantTotal)
			}
			if hasMore != tc.wantMore {
				t.Fatalf("hasMore = %v, want %v", hasMore, tc.wantMore)
			}
			switch {
			case tc.wantNext == nil && next != nil:
				t.Fatalf("nextOffset = %d, want nil", *next)
			case tc.wantNext != nil && next == nil:
				t.Fatalf("nextOffset = nil, want %d", *tc.wantNext)
			case tc.wantNext != nil && *next != *tc.wantNext:
				t.Fatalf("nextOffset = %d, want %d", *next, *tc.wantNext)
			}
		})
	}
}

func TestPreviewPageEmptyText(t *testing.T) {
	preview, total, hasMore, next := previewPage("", 0, 10)
	if preview != "" || total != 0 || hasMore || next != nil {
		t.Fatalf("empty text page = (%q,%d,%v,%v), want empty page", preview, total, hasMore, next)
	}
}

func TestIsTextLikeFile(t *testing.T) {
	cases := []struct {
		name     string
		mime     string
		filename string
		want     bool
	}{
		{"text mime", "text/plain", "a.bin", true},
		{"text mime upper", "TEXT/CSV", "x", true},
		{"json mime", "application/json", "x", true},
		{"xml mime", "application/xml", "x", true},
		{"tex by extension", "application/octet-stream", "paper.tex", true},
		{"log by extension", "", "build.log", true},
		{"csv by extension", "application/octet-stream", "table.CSV", true},
		{"script by extension", "binary/octet-stream", "run.py", true},
		{"pdf is not text-like", "application/pdf", "doc.pdf", false},
		{"zip is not text-like", "application/zip", "archive.zip", false},
		{"unknown extension", "application/octet-stream", "blob.bin", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTextLikeFile(tc.mime, tc.filename); got != tc.want {
				t.Fatalf("isTextLikeFile(%q, %q) = %v, want %v", tc.mime, tc.filename, got, tc.want)
			}
		})
	}
}

func TestExtractPreviewTextParsersAndFallbacks(t *testing.T) {
	cases := []struct {
		name         string
		mime         string
		filename     string
		data         []byte
		wantContains string
		wantNoParser bool
	}{
		{"markdown parser", "text/markdown", "doc.md", []byte("# 标题\n正文"), "# 标题", false},
		{"plain text parser", "text/plain", "notes.txt", []byte("hello preview"), "hello preview", false},
		{"tex raw fallback", "application/octet-stream", "paper.tex", []byte("\\section{方法}"), "\\section{方法}", false},
		{"log raw fallback", "", "run.log", []byte("line1\nline2"), "line1", false},
		{"csv raw fallback", "application/octet-stream", "data.CSV", []byte("a,b\n1,2"), "a,b", false},
		{"unknown binary has no parser", "application/zip", "archive.zip", []byte("PK\x03\x04"), "", true},
		{"malformed docx is a parse error", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "broken.docx", []byte("not-a-zip"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text, err := extractPreviewText(tc.mime, tc.filename, tc.data)
			if tc.wantNoParser {
				if !errors.Is(err, pipeline.ErrNoParser) {
					t.Fatalf("err = %v, want ErrNoParser", err)
				}
				if text != "" {
					t.Fatalf("text = %q, want empty on no parser", text)
				}
				return
			}
			if tc.wantContains != "" {
				if err != nil {
					t.Fatalf("unexpected err: %v", err)
				}
				if !strings.Contains(text, tc.wantContains) {
					t.Fatalf("text = %q, want it to contain %q", text, tc.wantContains)
				}
				return
			}
			// Remaining cases are expected to fail extraction (malformed docs).
			if err == nil {
				t.Fatalf("err = nil, want a parse error (text=%q)", text)
			}
			if text != "" {
				t.Fatalf("text = %q, want empty on parse error", text)
			}
		})
	}
}

func TestExtractPreviewTextInvalidUTF8Fallback(t *testing.T) {
	text, err := extractPreviewText("application/octet-stream", "raw.log", []byte{'h', 0xff, 'i'})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !strings.Contains(text, "h") || !strings.Contains(text, "i") {
		t.Fatalf("text = %q, want the surrounding ASCII bytes", text)
	}
	if !strings.Contains(text, "\uFFFD") {
		t.Fatalf("text = %q, want invalid bytes replaced with U+FFFD", text)
	}
}

func TestExtractPreviewTextDocx(t *testing.T) {
	text, err := extractPreviewText(
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"ai-generated.docx", minimalDocx(t, "你好文档正文"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !strings.Contains(text, "你好文档正文") {
		t.Fatalf("docx text = %q, want the paragraph text", text)
	}
}

func TestExtractPreviewFromObject(t *testing.T) {
	base := func() *model.CloudFile {
		return &model.CloudFile{
			UploadUUID:   "u-1",
			OriginalName: "paper.tex",
			MimeType:     "application/octet-stream",
			ObjectKey:    "cloud/u-1/paper.tex",
			FileSize:     24,
		}
	}

	t.Run("success reads the object key", func(t *testing.T) {
		file := base()
		var gotKey string
		fetch := func(_ context.Context, key string) ([]byte, error) {
			gotKey = key
			return []byte("\\documentclass{article}"), nil
		}
		text, ok := extractPreviewFromObject(context.Background(), file, fetch)
		if !ok || !strings.Contains(text, "documentclass") {
			t.Fatalf("ok=%v text=%q, want the raw text", ok, text)
		}
		if gotKey != file.ObjectKey {
			t.Fatalf("fetched key = %q, want %q", gotKey, file.ObjectKey)
		}
	})

	t.Run("declared size over the limit skips the read", func(t *testing.T) {
		file := base()
		file.FileSize = previewExtractMaxBytes + 1
		called := false
		fetch := func(context.Context, string) ([]byte, error) {
			called = true
			return []byte("ignored"), nil
		}
		if _, ok := extractPreviewFromObject(context.Background(), file, fetch); ok {
			t.Fatal("ok = true, want false for oversized file")
		}
		if called {
			t.Fatal("fetch was called for an oversized file")
		}
	})

	t.Run("object read error degrades to empty", func(t *testing.T) {
		fetch := func(context.Context, string) ([]byte, error) {
			return nil, errors.New("minio down")
		}
		if text, ok := extractPreviewFromObject(context.Background(), base(), fetch); ok || text != "" {
			t.Fatalf("ok=%v text=%q, want empty preview", ok, text)
		}
	})

	t.Run("downloaded bytes over the limit degrades to empty", func(t *testing.T) {
		fetch := func(context.Context, string) ([]byte, error) {
			return make([]byte, previewExtractMaxBytes+1), nil
		}
		if _, ok := extractPreviewFromObject(context.Background(), base(), fetch); ok {
			t.Fatal("ok = true, want false when the downloaded object exceeds the limit")
		}
	})

	t.Run("nil fetcher and nil file degrade to empty", func(t *testing.T) {
		if _, ok := extractPreviewFromObject(context.Background(), base(), nil); ok {
			t.Fatal("ok = true, want false for a nil fetcher")
		}
		if _, ok := extractPreviewFromObject(context.Background(), nil, func(context.Context, string) ([]byte, error) {
			return []byte("x"), nil
		}); ok {
			t.Fatal("ok = true, want false for a nil file")
		}
	})

	t.Run("missing object key degrades to empty", func(t *testing.T) {
		file := base()
		file.ObjectKey = "  "
		if _, ok := extractPreviewFromObject(context.Background(), file, func(context.Context, string) ([]byte, error) {
			t.Fatal("fetch must not be called without an object key")
			return nil, nil
		}); ok {
			t.Fatal("ok = true, want false without an object key")
		}
	})

	t.Run("unknown binary degrades to empty", func(t *testing.T) {
		file := base()
		file.OriginalName = "blob.bin"
		file.MimeType = "application/zip"
		fetch := func(context.Context, string) ([]byte, error) {
			return []byte("PK\x03\x04binary"), nil
		}
		if _, ok := extractPreviewFromObject(context.Background(), file, fetch); ok {
			t.Fatal("ok = true, want false for a binary file without parser")
		}
	})

	t.Run("blank text degrades to empty", func(t *testing.T) {
		file := base()
		file.OriginalName = "blank.log"
		fetch := func(context.Context, string) ([]byte, error) {
			return []byte(" \n\t "), nil
		}
		if _, ok := extractPreviewFromObject(context.Background(), file, fetch); ok {
			t.Fatal("ok = true, want false for whitespace-only text")
		}
	})
}

func TestPreviewPageEmojiRunes(t *testing.T) {
	// 3 runes, but 6 bytes: slicing must use rune (not byte) offsets.
	const text = "a😀b"
	preview, total, hasMore, next := previewPage(text, 1, 1)
	if preview != "😀" {
		t.Fatalf("preview = %q, want the emoji rune", preview)
	}
	if total != 3 {
		t.Fatalf("totalChars = %d, want 3", total)
	}
	if !hasMore || next == nil || *next != 2 {
		t.Fatalf("hasMore=%v next=%v, want true/2", hasMore, next)
	}
	preview, total, hasMore, next = previewPage(text, 2, 5)
	if preview != "b" || total != 3 || hasMore || next != nil {
		t.Fatalf("tail page = (%q,%d,%v,%v), want (b,3,false,nil)", preview, total, hasMore, next)
	}
}

// minimalDocx builds the smallest valid OOXML wordprocessing zip for the
// extraction tests (no external fixtures).
func minimalDocx(t *testing.T, paragraph string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatalf("zip create: %v", err)
	}
	xml := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + paragraph + `</w:t></w:r></w:p></w:body></w:document>`
	if _, err := w.Write([]byte(xml)); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}
