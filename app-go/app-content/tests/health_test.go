package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"app-content/internal/bootstrap"
)

func TestHealthAggregatesAllDomains(t *testing.T) {
	ok := func(context.Context) error { return nil }
	handler := bootstrap.HealthHandler([]bootstrap.HealthChecker{
		{Name: "board", Ping: ok},
		{Name: "note", Ping: ok},
		{Name: "quiz", Ping: ok},
	})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "app-content" {
		t.Fatalf("body = %v", body)
	}
	domains, _ := body["domains"].(map[string]any)
	if len(domains) != 3 {
		t.Fatalf("domains = %v", domains)
	}
}

func TestHealthIs503WhenAnyDomainMysqlDown(t *testing.T) {
	handler := bootstrap.HealthHandler([]bootstrap.HealthChecker{
		{Name: "board", Ping: func(context.Context) error { return nil }},
		{Name: "note", Ping: func(context.Context) error { return errors.New("mysql down") }},
		{Name: "quiz", Ping: func(context.Context) error { return nil }},
	})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != "degraded" {
		t.Fatalf("body = %v", body)
	}
}
