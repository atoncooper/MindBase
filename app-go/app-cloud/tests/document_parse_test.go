package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"app-cloud/internal/pipeline"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// testPNG renders a small valid PNG for the OCR/PDF fixtures.
func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 100, B: 50, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// imageOnlyPDF builds a valid PDF whose only page content is the given images
// (no text operators) — the scanned-document shape.
func imageOnlyPDF(t *testing.T, images ...[]byte) []byte {
	t.Helper()
	readers := make([]io.Reader, len(images))
	for i := range images {
		readers[i] = bytes.NewReader(images[i])
	}
	var out bytes.Buffer
	if err := api.ImportImages(nil, &out, readers, nil, nil); err != nil {
		t.Fatalf("build image-only pdf: %v", err)
	}
	return out.Bytes()
}

func TestImageFileParsedThroughOCR(t *testing.T) {
	srv, calls := ocrGateway(t, []string{"图片里的文字"})
	defer srv.Close()

	parsed, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"image/png", "screenshot.png", testPNG(t))
	if err != nil {
		t.Fatalf("parse image: %v", err)
	}
	if parsed.Source != "ocr" {
		t.Fatalf("source = %q, want ocr", parsed.Source)
	}
	if !strings.Contains(parsed.Text, "图片里的文字") {
		t.Fatalf("text = %q", parsed.Text)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("calls = %d, want 1", got)
	}
}

func TestImageOCRDisabledIsPermanentSkip(t *testing.T) {
	_, err := pipeline.ParseDocument(context.Background(), disabledOCRClient(),
		"image/png", "screenshot.png", testPNG(t))
	if !errors.Is(err, pipeline.ErrOCRDisabled) || !pipeline.IsPermanentOCRError(err) {
		t.Fatalf("want permanent ErrOCRDisabled, got %v", err)
	}
}

func TestScannedPDFParsedByPageImages(t *testing.T) {
	srv, calls := ocrGateway(t, []string{"第一页文字", "第二页文字"})
	defer srv.Close()

	parsed, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"application/pdf", "scan.pdf", imageOnlyPDF(t, testPNG(t), testPNG(t)))
	if err != nil {
		t.Fatalf("parse scanned pdf: %v", err)
	}
	if parsed.Source != "ocr" {
		t.Fatalf("source = %q, want ocr", parsed.Source)
	}
	if !strings.Contains(parsed.Text, "第一页文字") || !strings.Contains(parsed.Text, "第二页文字") {
		t.Fatalf("page texts missing: %q", parsed.Text)
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("calls = %d, want one per page image (2)", got)
	}
}

func TestScannedPDFOCRDisabledStaysEmptyPdfSkip(t *testing.T) {
	_, err := pipeline.ParseDocument(context.Background(), disabledOCRClient(),
		"application/pdf", "scan.pdf", imageOnlyPDF(t, testPNG(t)))
	if !errors.Is(err, pipeline.ErrEmptyPDFText) {
		t.Fatalf("want ErrEmptyPDFText when OCR is off, got %v", err)
	}
}

// A gateway outage must stay retryable (failed, not a permanent skip).
func TestScannedPDFTransientOCRFailureIsRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	_, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"application/pdf", "scan.pdf", imageOnlyPDF(t, testPNG(t)))
	if err == nil {
		t.Fatal("persistent gateway outage must fail the parse")
	}
	if pipeline.IsPermanentOCRError(err) {
		t.Fatalf("gateway outage must stay retryable, got permanent: %v", err)
	}
}

// Scanned PDF whose images contain no readable text is a permanent skip.
func TestScannedPDFNoReadableTextIsPermanent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": ""}}},
		})
	}))
	defer srv.Close()

	_, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"application/pdf", "scan.pdf", imageOnlyPDF(t, testPNG(t)))
	if !errors.Is(err, pipeline.ErrOCRNoContent) || !pipeline.IsPermanentOCRError(err) {
		t.Fatalf("want permanent ErrOCRNoContent, got %v", err)
	}
}

// Plain text documents never touch the vision gateway.
func TestTextDocumentDoesNotCallOCR(t *testing.T) {
	srv, calls := ocrGateway(t, []string{"不应调用"})
	defer srv.Close()

	parsed, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"text/plain", "notes.txt", []byte("普通文本正文"))
	if err != nil {
		t.Fatalf("parse text: %v", err)
	}
	if parsed.Source != "text" || !strings.Contains(parsed.Text, "普通文本正文") {
		t.Fatalf("text parser result wrong: %+v", parsed)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("text documents must not hit OCR; calls = %d", got)
	}
}

// Unsupported image media (e.g. TIFF) stays a permanent skip instead of
// burning gateway retries.
func TestUnsupportedImageMediaIsPermanent(t *testing.T) {
	srv, calls := ocrGateway(t, []string{"不应调用"})
	defer srv.Close()

	_, err := pipeline.ParseDocument(context.Background(), testOCRClient(t, srv.URL),
		"image/tiff", "scan.tiff", []byte{0x49, 0x49, 0x2a, 0x00})
	if !errors.Is(err, pipeline.ErrOCRUnsupportedImage) || !pipeline.IsPermanentOCRError(err) {
		t.Fatalf("want permanent ErrOCRUnsupportedImage, got %v", err)
	}
	if got := atomic.LoadInt32(calls); got != 0 {
		t.Fatalf("unsupported media must not reach the gateway; calls = %d", got)
	}
}
