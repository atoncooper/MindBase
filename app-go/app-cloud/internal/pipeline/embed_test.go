package pipeline

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"app-cloud/internal/config"
)

// P1-D regression: transient embedding failures (transport errors, 429/5xx)
// retry with backoff up to embedMaxAttempts; other 4xx fail immediately.
func TestEmbedRetriesTransientFailures(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("upstream busy"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"index": 0, "embedding": []float32{0.1, 0.2}},
				{"index": 1, "embedding": []float32{0.3, 0.4}},
			},
		})
	}))
	defer srv.Close()

	e := NewEmbedder(config.EmbeddingConfig{BaseURL: srv.URL, APIKey: "k", BatchSize: 2})
	vecs, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil {
		t.Fatalf("expected success after transient retries: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 calls (2 transient + 1 ok), got %d", got)
	}
	if len(vecs) != 2 || len(vecs[0]) != 2 {
		t.Fatalf("unexpected vectors: %v", vecs)
	}
}

func TestEmbedDoesNotRetryClientErrors(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad request"))
	}))
	defer srv.Close()

	e := NewEmbedder(config.EmbeddingConfig{BaseURL: srv.URL, APIKey: "k", BatchSize: 2})
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("expected a 400 to fail the batch")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("a 400 must not be retried; got %d calls", got)
	}
}

func TestEmbedGivesUpAfterMaxAttempts(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	e := NewEmbedder(config.EmbeddingConfig{BaseURL: srv.URL, APIKey: "k", BatchSize: 2})
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("expected persistent 502 to fail the batch")
	}
	if got := atomic.LoadInt32(&calls); got != int32(embedMaxAttempts) {
		t.Fatalf("expected %d attempts, got %d", embedMaxAttempts, got)
	}
}