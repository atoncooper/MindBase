package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/model"
	"app-cloud/internal/service"
)

func TestSummaryReadNotOwnedIsNotFound(t *testing.T) {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{
		"u1": {UploadUUID: "u1", UID: 2, OriginalName: "other.pdf"},
	}}
	svc := service.NewSummaryServiceWithPorts(nil, files, &fakeSummaryStore{})
	if _, err := svc.Get(context.Background(), 1, "u1"); !errors.Is(err, service.ErrNotFound) {
		t.Fatalf("want ErrNotFound for another owner's file, got %v", err)
	}
}

func TestSummaryReadWithoutStoredSummary(t *testing.T) {
	file := cloudFile("u1", 1)
	file.Title = strPtr("标题")
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": file}}
	svc := service.NewSummaryServiceWithPorts(nil, files, &fakeSummaryStore{})

	view, err := svc.Get(context.Background(), 1, "u1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Available || view.Stale || view.Summary != nil {
		t.Fatalf("no stored summary must report unavailable: %+v", view)
	}
	if view.OriginalName != "u1.pdf" || view.Title != "标题" {
		t.Fatalf("file identity missing: %+v", view)
	}
}

func TestSummaryReadAvailableAndStaleness(t *testing.T) {
	file := cloudFile("u1", 1)
	file.ContentHash = strPtr("hash-new")
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": file}}
	store := &fakeSummaryStore{stored: map[string]*mongostore.StoredSummary{
		"u1": {
			Model:       "z-ai/glm-5.3-flash",
			ContentHash: "hash-new",
			Summary: map[string]any{
				"overview":          "文档概览",
				"topics":            []any{"主题"},
				"entities":          []any{"实体"},
				"key_points":        []any{"要点"},
				"todos":             []any{"待办一", "待办二"},
				"answers_questions": []any{"能回答什么"},
				"language":          "zh",
				"size_chars":        1234,
			},
		},
	}}
	svc := service.NewSummaryServiceWithPorts(nil, files, store)

	view, err := svc.Get(context.Background(), 1, "u1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !view.Available || view.Stale {
		t.Fatalf("fresh summary must be available and not stale: %+v", view)
	}
	if view.Model != "z-ai/glm-5.3-flash" || view.Summary == nil || view.Summary.Overview != "文档概览" {
		t.Fatalf("summary payload wrong: %+v", view)
	}
	if len(view.Summary.Todos) != 2 || view.Summary.Todos[0] != "待办一" {
		t.Fatalf("todos lost: %+v", view.Summary.Todos)
	}
	if view.Summary.SizeChars != 1234 {
		t.Fatalf("size_chars = %d", view.Summary.SizeChars)
	}

	// The document content changed after the summary was generated.
	file.ContentHash = strPtr("hash-changed")
	view, err = svc.Get(context.Background(), 1, "u1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !view.Available || !view.Stale {
		t.Fatalf("mismatched content hash must be stale: %+v", view)
	}
}

// Documents summarised before the todos field existed still decode, with an
// empty todos list.
func TestSummaryReadLegacyDocumentHasEmptyTodos(t *testing.T) {
	file := cloudFile("u1", 1)
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": file}}
	store := &fakeSummaryStore{stored: map[string]*mongostore.StoredSummary{
		"u1": {Model: "old-model", Summary: map[string]any{
			"overview": "旧摘要",
			"topics":   []any{"甲"},
		}},
	}}
	svc := service.NewSummaryServiceWithPorts(nil, files, store)
	view, err := svc.Get(context.Background(), 1, "u1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Summary == nil {
		t.Fatal("legacy summary must still decode")
	}
	if view.Summary.Todos == nil || len(view.Summary.Todos) != 0 {
		t.Fatalf("legacy document must expose an empty todos list, got %#v", view.Summary.Todos)
	}
	if view.Summary.Entities == nil || view.Summary.KeyPoints == nil || view.Summary.AnswersQuestions == nil {
		t.Fatalf("missing lists must decode as empty arrays, got %+v", view.Summary)
	}
}

func TestSummaryReadSurvivesMalformedStoredSummary(t *testing.T) {
	file := cloudFile("u1", 1)
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": file}}
	store := &fakeSummaryStore{stored: map[string]*mongostore.StoredSummary{
		"u1": {Summary: map[string]any{"overview": 42}}, // wrong type
	}}
	svc := service.NewSummaryServiceWithPorts(nil, files, store)
	view, err := svc.Get(context.Background(), 1, "u1")
	if err != nil {
		t.Fatalf("malformed summary must not fail the read: %v", err)
	}
	if view.Available || view.Summary != nil {
		t.Fatalf("malformed summary must report unavailable: %+v", view)
	}
}

func TestSummaryReadPropagatesStoreError(t *testing.T) {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": cloudFile("u1", 1)}}
	svc := service.NewSummaryServiceWithPorts(nil, files, &fakeSummaryStore{err: errors.New("mongo down")})
	if _, err := svc.Get(context.Background(), 1, "u1"); err == nil {
		t.Fatal("store errors must propagate so the handler can answer 500")
	}
}

// The summary prompt must request the todos field and the parser must keep it.
func TestSummarizerRequestsAndParsesTodos(t *testing.T) {
	var systemContent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if msgs, ok := body["messages"].([]any); ok && len(msgs) > 0 {
			if system, ok := msgs[0].(map[string]any); ok {
				systemContent, _ = system["content"].(string)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{
				"content": `{"overview":"概览","topics":["主题"],"entities":[],"key_points":["要点"],"todos":["下一步一","下一步二"],"answers_questions":["问题"],"language":"zh"}`,
			}}},
		})
	}))
	defer srv.Close()

	summarizer := service.NewSummarizer(config.SummaryConfig{
		Enabled: true, Model: "test-flash", MaxInputChars: 60000, MaxOutputTok: 1500,
	}, "test-key", srv.URL)
	if !summarizer.Enabled() {
		t.Fatal("summarizer should be enabled with a model and gateway")
	}
	sum, err := summarizer.Summarize(context.Background(), "标题", "正文")
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if !strings.Contains(systemContent, "todos") {
		t.Fatalf("summary prompt must request todos: %q", systemContent)
	}
	if len(sum.Todos) != 2 || sum.Todos[1] != "下一步二" {
		t.Fatalf("todos lost after parsing: %+v", sum.Todos)
	}
}
