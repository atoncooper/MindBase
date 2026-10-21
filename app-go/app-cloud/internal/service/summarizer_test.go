package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"app-cloud/internal/config"
)

func testConfig() config.SummaryConfig {
	return config.SummaryConfig{Enabled: true, Model: "test-flash", MaxInputChars: 60000, MaxOutputTok: 1500}
}

const goodSummary = `{"overview":"一份测试文档","topics":["测试"],"entities":[],"key_points":["要点"],"answers_questions":["它讲什么？"],"language":"zh"}`

func TestSummarizeParsesCleanJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": goodSummary}}},
		})
	}))
	defer srv.Close()

	s := NewSummarizer(testConfig(), "k", srv.URL)
	sum, err := s.Summarize(context.Background(), "标题", "正文")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sum.Overview != "一份测试文档" || len(sum.Topics) != 1 {
		t.Fatalf("unexpected summary: %+v", sum)
	}
}

func TestSummarizeToleratesMarkdownFences(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": "```json\n" + goodSummary + "\n```"}}},
		})
	}))
	defer srv.Close()

	s := NewSummarizer(testConfig(), "k", srv.URL)
	if _, err := s.Summarize(context.Background(), "标题", "正文"); err != nil {
		t.Fatalf("fenced JSON must parse: %v", err)
	}
}

func TestSummarizeRetriesFormatViolations(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		content := "这不是 JSON"
		if n >= 2 {
			content = goodSummary
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	defer srv.Close()

	s := NewSummarizer(testConfig(), "k", srv.URL)
	if _, err := s.Summarize(context.Background(), "标题", "正文"); err != nil {
		t.Fatalf("expected recovery after a format violation: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
	}
}

func TestSummarizeDoesNotRetryClientErrors(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := NewSummarizer(testConfig(), "bad-key", srv.URL)
	if _, err := s.Summarize(context.Background(), "标题", "正文"); err == nil {
		t.Fatal("expected 401 to fail")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("a 401 must not be retried; got %d calls", got)
	}
}

func TestLongInputTruncatedOnRuneBoundary(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		for _, m := range req.Messages {
			if m.Role == "user" {
				got = m.Content
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": goodSummary}}},
		})
	}))
	defer srv.Close()

	cfg := testConfig()
	cfg.MaxInputChars = 100
	s := NewSummarizer(cfg, "k", srv.URL)
	text := strings.Repeat("汉", 100) // 300 bytes, 100 runes
	if _, err := s.Summarize(context.Background(), "标题", text); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !utf8.ValidString(got) {
		t.Fatal("truncated user content must stay valid UTF-8 (no mid-rune cuts)")
	}
	if !strings.Contains(got, "[文档过长，已截断]") {
		t.Fatal("truncation marker missing")
	}
	// 100-byte cap over 3-byte runes → exactly 33 full 汉 survive the cut
	// (byte 99 is the lead byte of the 34th and is stripped).
	if n := strings.Count(got, "汉"); n != 33 {
		t.Fatalf("expected 33 surviving runes after boundary-safe truncation, got %d", n)
	}
}

func TestEnabledRequiresModel(t *testing.T) {
	cfg := testConfig()
	cfg.Model = ""
	if NewSummarizer(cfg, "k", "http://x").Enabled() {
		t.Fatal("empty model must disable the stage")
	}
	if NewSummarizer(cfg, "k", "http://x").ModelName() != "" {
		t.Fatal("ModelName should mirror config")
	}
}
