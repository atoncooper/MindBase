package tests

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/pipeline"
)

func TestOCRRecognizeSendsImageDataURL(t *testing.T) {
	var (
		auth string
		path string
		body map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "  识别到的文字  "}}},
		})
	}))
	defer srv.Close()

	client := testOCRClient(t, srv.URL)
	image := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	text, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: image, MimeType: "image/png"})
	if err != nil {
		t.Fatalf("recognize: %v", err)
	}
	if text != "识别到的文字" {
		t.Fatalf("text = %q, want trimmed OCR text", text)
	}
	if path != "/chat/completions" {
		t.Fatalf("path = %q, want /chat/completions", path)
	}
	if auth != "Bearer test-key" {
		t.Fatalf("authorization = %q", auth)
	}
	if body["model"] != "z-ai/glm-test" {
		t.Fatalf("model = %v", body["model"])
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %v", body["messages"])
	}
	msg, _ := messages[0].(map[string]any)
	if msg["role"] != "user" {
		t.Fatalf("role = %v", msg["role"])
	}
	parts, _ := msg["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("content parts = %v", msg["content"])
	}
	textPart, _ := parts[0].(map[string]any)
	if textPart["type"] != "text" || !strings.Contains(textPart["text"].(string), "全部文字") {
		t.Fatalf("text part = %v", textPart)
	}
	imagePart, _ := parts[1].(map[string]any)
	if imagePart["type"] != "image_url" {
		t.Fatalf("image part = %v", imagePart)
	}
	imageURL := imagePart["image_url"].(map[string]any)["url"].(string)
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(imageURL, prefix) {
		t.Fatalf("image url prefix = %q", imageURL[:minInt(len(imageURL), len(prefix))])
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(imageURL, prefix))
	if err != nil || string(decoded) != string(image) {
		t.Fatalf("image payload round-trip failed: %v", err)
	}
}

func TestOCRRetriesTransientFailures(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "恢复后的文字"}}},
		})
	}))
	defer srv.Close()

	client := testOCRClient(t, srv.URL)
	text, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("img"), MimeType: "image/jpeg"})
	if err != nil {
		t.Fatalf("expected recovery after transient failures: %v", err)
	}
	if text != "恢复后的文字" {
		t.Fatalf("text = %q", text)
	}
	// The first call plus at most two retries.
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("calls = %d, want 3", got)
	}
}

func TestOCRDoesNotRetryUnsupportedMedia(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("invalid image"))
	}))
	defer srv.Close()

	client := testOCRClient(t, srv.URL)
	_, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("img"), MimeType: "image/png"})
	if !errors.Is(err, pipeline.ErrOCRUnsupportedImage) {
		t.Fatalf("want ErrOCRUnsupportedImage, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("a 400 must not be retried; calls = %d", got)
	}
}

func TestOCREmptyCompletionIsPermanentNoContent(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": ""}}},
		})
	}))
	defer srv.Close()

	client := testOCRClient(t, srv.URL)
	_, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("img"), MimeType: "image/png"})
	if !errors.Is(err, pipeline.ErrOCRNoContent) {
		t.Fatalf("want ErrOCRNoContent, got %v", err)
	}
	if !pipeline.IsPermanentOCRError(err) {
		t.Fatal("empty OCR output must be a permanent skip, not a retryable failure")
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("empty completions retry then give up; calls = %d", got)
	}
}

func TestOCRDisabledAndOversize(t *testing.T) {
	disabled := disabledOCRClient()
	if disabled.Enabled() {
		t.Fatal("disabled config must not enable OCR")
	}
	if _, err := disabled.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("x"), MimeType: "image/png"}); !errors.Is(err, pipeline.ErrOCRDisabled) {
		t.Fatalf("want ErrOCRDisabled, got %v", err)
	}

	cfg := config.OCRConfig{Enabled: true, Model: "m", MaxImageBytes: 4, TimeoutSecs: 1}
	client := pipeline.NewOCRClient(cfg, config.EmbeddingConfig{BaseURL: "http://unused", APIKey: "k"})
	if _, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("12345"), MimeType: "image/png"}); !errors.Is(err, pipeline.ErrImageTooLarge) {
		t.Fatalf("want ErrImageTooLarge, got %v", err)
	}
}

// An OCR stage without its own credentials reuses the embedding gateway —
// one AI_GATEWAY__* pair wires both.
func TestOCRInheritsEmbeddingConnection(t *testing.T) {
	var sharedCalls int32
	var sharedAuth string
	shared := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&sharedCalls, 1)
		sharedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "继承网关"}}},
		})
	}))
	defer shared.Close()

	inherited := pipeline.NewOCRClient(
		config.OCRConfig{Enabled: true, Model: "m", TimeoutSecs: 5},
		config.EmbeddingConfig{BaseURL: shared.URL, APIKey: "shared-key"},
	)
	if !inherited.Enabled() {
		t.Fatal("OCR should use the shared Higress gateway connection")
	}
	if _, err := inherited.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("img"), MimeType: "image/png"}); err != nil {
		t.Fatalf("inherited-gateway OCR: %v", err)
	}
	if atomic.LoadInt32(&sharedCalls) != 1 || sharedAuth != "Bearer shared-key" {
		t.Fatalf("inherited calls = %d, auth = %q", sharedCalls, sharedAuth)
	}
}

// OpenAI-compatible gateways may answer with content parts instead of a plain
// string; the text parts are joined.
func TestOCRJoinsContentPartArrays(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{
				"content": []any{
					map[string]any{"type": "text", "text": "甲"},
					map[string]any{"type": "text", "text": "乙"},
				},
			}}},
		})
	}))
	defer srv.Close()

	client := testOCRClient(t, srv.URL)
	text, err := client.Recognize(context.Background(), pipeline.OCRImage{Data: []byte("img"), MimeType: "image/png"})
	if err != nil {
		t.Fatalf("recognize: %v", err)
	}
	if text != "甲乙" {
		t.Fatalf("text = %q, want joined content parts", text)
	}
}

func TestNormalizeImageMime(t *testing.T) {
	cases := []struct {
		mime string
		data []byte
		want string
	}{
		{"image/png", nil, "image/png"},
		{"image/jpeg; charset=binary", nil, "image/jpeg"},
		{"", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, "image/png"},
		{"image/tiff", nil, ""},
		{"application/octet-stream", []byte("not an image"), ""},
	}
	for i, c := range cases {
		if got := pipeline.NormalizeImageMime(c.mime, c.data); got != c.want {
			t.Fatalf("case %d (%q): got %q, want %q", i, c.mime, got, c.want)
		}
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
