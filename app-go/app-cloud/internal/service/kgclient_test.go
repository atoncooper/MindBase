package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"app-cloud/internal/config"
)

func TestKgClientUpsertSendsTokenPathAndPayload(t *testing.T) {
	var gotPath, gotToken, gotUUID, gotTopic string
	var gotUID float64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Internal-Token")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotUID, _ = body["uid"].(float64)
		gotUUID = body["upload_uuid"].(string)
		gotTopic = body["topics"].([]any)[0].(string)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	c := NewKgClient(config.KgConfig{BaseURL: srv.URL, Token: "tok"})
	err := c.UpsertCloudDocGraph(context.Background(), 42, "uuid-1", "标题", "hash", []string{"主题"}, nil)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if gotPath != "/internal/kg/cloud-doc/upsert" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotToken != "tok" {
		t.Fatalf("internal token not sent: %q", gotToken)
	}
	if gotUID != 42 || gotUUID != "uuid-1" || gotTopic != "主题" {
		t.Fatalf("payload mismatch: %v %v %v", gotUID, gotUUID, gotTopic)
	}
}

func TestKgClientDeletePath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewKgClient(config.KgConfig{BaseURL: srv.URL})
	if err := c.DeleteCloudDocGraph(context.Background(), 7, "uuid-2"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if gotPath != "/internal/kg/cloud-doc/delete" {
		t.Fatalf("path = %q", gotPath)
	}
}

func TestKgClientSurfacesUpstreamErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewKgClient(config.KgConfig{BaseURL: srv.URL})
	if err := c.UpsertCloudDocGraph(context.Background(), 1, "u", "t", "h", nil, nil); err == nil {
		t.Fatal("500 must surface as an error (caller treats it as non-fatal but visible)")
	}
}

func TestKgClientUnconfiguredFailsFast(t *testing.T) {
	c := NewKgClient(config.KgConfig{})
	if c.Enabled() {
		t.Fatal("empty base URL must disable the client")
	}
	if err := c.UpsertCloudDocGraph(context.Background(), 1, "u", "t", "h", nil, nil); err == nil {
		t.Fatal("unconfigured client must fail fast, not no-op silently")
	}
}
