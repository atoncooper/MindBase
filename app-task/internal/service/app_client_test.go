package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── RequestQuiz: POST /generate-llm (async) ──────────────────────

func TestRequestQuiz_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("apikey") != "test-key" {
			t.Errorf("apikey = %q, want test-key", r.Header.Get("apikey"))
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["task_id"] != "t1" {
			t.Errorf("task_id = %v", body["task_id"])
		}
		if body["difficulty"] != "hard" {
			t.Errorf("difficulty = %v", body["difficulty"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "generating"})
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "test-key", llmPath: "/internal/quiz/generate-llm", statusPath: "/internal/quiz/status/", httpClient: srv.Client()}
	resp, err := c.RequestQuiz("t1", "prompt", 1, "hard")
	if err != nil {
		t.Fatalf("RequestQuiz: %v", err)
	}
	if resp.Status != "generating" {
		t.Errorf("status = %q, want generating", resp.Status)
	}
}

func TestRequestQuiz_Ready(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status": "ready",
			"quiz": map[string]any{
				"question": "q", "answer": "A", "answer_time_limit_seconds": 600,
			},
		})
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: srv.Client()}
	resp, err := c.RequestQuiz("t1", "p", 1, "medium")
	if err != nil {
		t.Fatalf("RequestQuiz: %v", err)
	}
	if resp.Status != "ready" {
		t.Errorf("status = %q, want ready", resp.Status)
	}
	if resp.Quiz == nil || resp.Quiz.Answer != "A" {
		t.Errorf("quiz = %+v, want answer A", resp.Quiz)
	}
}

func TestRequestQuiz_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: srv.Client()}
	_, err := c.RequestQuiz("t1", "p", 1, "medium")
	if err == nil {
		t.Fatal("want error on 500")
	}
}

func TestRequestQuiz_NotConfigured(t *testing.T) {
	c := &AppClient{baseURL: "", apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: &http.Client{}}
	_, err := c.RequestQuiz("t1", "p", 1, "medium")
	if err == nil {
		t.Fatal("want error when baseURL empty")
	}
}

// ── GetQuizStatus: GET /status/{taskID} ──────────────────────────

func TestGetQuizStatus_Ready(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/s/t1" {
			t.Errorf("path = %q, want /s/t1", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status": "ready",
			"quiz":   map[string]any{"question": "q", "answer": "A"},
		})
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: srv.Client()}
	resp, err := c.GetQuizStatus("t1")
	if err != nil {
		t.Fatalf("GetQuizStatus: %v", err)
	}
	if resp.Status != "ready" || resp.Quiz == nil {
		t.Errorf("resp = %+v, want ready+quiz", resp)
	}
}

func TestGetQuizStatus_Failed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "failed", "error": "LLM error"})
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: srv.Client()}
	resp, err := c.GetQuizStatus("t1")
	if err != nil {
		t.Fatalf("GetQuizStatus: %v", err)
	}
	if resp.Status != "failed" || resp.Error != "LLM error" {
		t.Errorf("resp = %+v, want failed+error", resp)
	}
}

func TestGetQuizStatus_Generating(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "generating"})
	}))
	defer srv.Close()

	c := &AppClient{baseURL: srv.URL, apiKey: "k", llmPath: "/p", statusPath: "/s/", httpClient: srv.Client()}
	resp, err := c.GetQuizStatus("t1")
	if err != nil {
		t.Fatalf("GetQuizStatus: %v", err)
	}
	if resp.Status != "generating" {
		t.Errorf("status = %q, want generating", resp.Status)
	}
}
