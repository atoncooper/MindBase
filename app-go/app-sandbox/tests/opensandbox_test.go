package tests

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/runtime"
)

// The adapter must speak the published OpenSandbox contracts: lifecycle
// create/get/delete/endpoint resolution plus execd file upload + command SSE.

func TestOpenSandboxLifecycleContract(t *testing.T) {
	var mu sync.Mutex
	var created map[string]any
	deleted := false

	execd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer execd.Close()

	lifecycle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sandboxes":
			if got := r.Header.Get("OPEN-SANDBOX-API-KEY"); got != "test-key" {
				t.Errorf("create api key = %q", got)
			}
			body, _ := io.ReadAll(r.Body)
			var payload map[string]any
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatalf("create body: %v", err)
			}
			mu.Lock()
			created = payload
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"sbx-1","status":{"state":"Pending"},"createdAt":"2026-01-02T03:04:05Z"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sandboxes/sbx-1":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"sbx-1","status":{"state":"Running"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sandboxes/sbx-1/endpoints/44772":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"endpoint":"` + execd.URL + `","headers":{"X-Sandbox-Token":"t"}}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/sandboxes/sbx-1":
			mu.Lock()
			deleted = true
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected lifecycle request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer lifecycle.Close()

	adapter := runtime.NewOpenSandbox(config.OpenSandboxConfig{
		LifecycleBaseURL: lifecycle.URL + "/v1",
		APIKey:           "test-key",
		ExecdPort:        44772,
	})
	ctx := context.Background()

	sandbox, err := adapter.Create(ctx, runtime.CreateSpec{
		UID: 7, ProjectID: "p1", Purpose: "academic", SpecHash: "h1",
		Image: "python:3.12", CPU: "500m", Memory: "512Mi",
		Timeout: 30 * time.Minute,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if sandbox.ID != "sbx-1" || sandbox.State != "Pending" {
		t.Fatalf("create result = %+v", sandbox)
	}
	mu.Lock()
	payload := created
	mu.Unlock()
	if image, _ := payload["image"].(map[string]any); image["uri"] != "python:3.12" {
		t.Errorf("image.uri = %v", payload["image"])
	}
	if payload["timeout"] != float64(1800) {
		t.Errorf("timeout = %v, want seconds", payload["timeout"])
	}
	if limits, _ := payload["resourceLimits"].(map[string]any); limits["cpu"] != "500m" || limits["memory"] != "512Mi" {
		t.Errorf("resourceLimits = %v", payload["resourceLimits"])
	}
	if metadata, _ := payload["metadata"].(map[string]any); metadata["uid"] != "7" || metadata["projectId"] != "p1" {
		t.Errorf("metadata = %v", payload["metadata"])
	}

	got, err := adapter.Get(ctx, "sbx-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.State != "Running" {
		t.Fatalf("state = %q", got.State)
	}

	endpoint, err := adapter.Endpoint(ctx, "sbx-1")
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if endpoint != execd.URL {
		t.Fatalf("endpoint = %q", endpoint)
	}

	if err := adapter.Delete(ctx, "sbx-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	mu.Lock()
	wasDeleted := deleted
	mu.Unlock()
	if !wasDeleted {
		t.Fatal("delete was not issued")
	}
}

func TestOpenSandboxExecStreamsCommandOutput(t *testing.T) {
	var mu sync.Mutex
	var uploadPaths []string
	var commandBody map[string]any
	execd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/files/upload":
			reader, err := r.MultipartReader()
			if err != nil {
				t.Errorf("multipart: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Errorf("part: %v", err)
					break
				}
				if part.FormName() == "metadata" {
					raw, _ := io.ReadAll(part)
					var meta map[string]any
					_ = json.Unmarshal(raw, &meta)
					if path, _ := meta["path"].(string); path != "" {
						mu.Lock()
						uploadPaths = append(uploadPaths, path)
						mu.Unlock()
					}
				}
				_, _ = io.Copy(io.Discard, part)
			}
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/command":
			if got := r.Header.Get("X-Sandbox-Token"); got != "t" {
				t.Errorf("execd token header = %q", got)
			}
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			_ = json.Unmarshal(body, &commandBody)
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("data: {\"type\":\"init\",\"id\":\"sess-1\"}\n\n"))
			_, _ = w.Write([]byte("data: {\"type\":\"stdout\",\"text\":\"hello\\n\"}\n\n"))
			_, _ = w.Write([]byte("data: {\"type\":\"stderr\",\"text\":\"warn\"}\n\n"))
			_, _ = w.Write([]byte("data: {\"type\":\"execution_complete\",\"exit_code\":0,\"execution_time\":12}\n\n"))
		default:
			t.Errorf("unexpected execd request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer execd.Close()

	// One lifecycle server resolves the execd endpoint; the execd server above
	// serves uploads and command streams.
	lifecycle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sandboxes/sbx-1/endpoints/44772" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"endpoint":"` + execd.URL + `","headers":{"X-Sandbox-Token":"t"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer lifecycle.Close()

	adapter := runtime.NewOpenSandbox(config.OpenSandboxConfig{LifecycleBaseURL: lifecycle.URL + "/v1", ExecdPort: 44772})
	result, err := adapter.Exec(context.Background(), runtime.ExecRequest{
		SandboxID: "sbx-1", Language: "python", Code: "print('hello')", Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if result.Stdout != "hello\n" || result.Stderr != "warn" || result.ExitCode != 0 {
		t.Fatalf("result = %+v", result)
	}
	if result.Duration != 12*time.Millisecond {
		t.Fatalf("duration = %v", result.Duration)
	}
	mu.Lock()
	paths := append([]string(nil), uploadPaths...)
	body := commandBody
	mu.Unlock()
	if len(paths) != 1 || !strings.HasPrefix(paths[0], "/tmp/osb-") || !strings.HasSuffix(paths[0], ".py") {
		t.Fatalf("upload paths = %v", paths)
	}
	if !strings.HasPrefix(body["command"].(string), "mkdir -p /workspace && cd /workspace && python3 '") {
		t.Fatalf("command = %v", body["command"])
	}
}

func TestOpenSandboxExecCancellationInterruptsSession(t *testing.T) {
	var mu sync.Mutex
	interrupted := ""
	var execd *httptest.Server
	lifecycle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"endpoint":"` + execd.URL + `"}`))
	}))
	defer lifecycle.Close()

	execd = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/files/upload":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/command":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)
			_, _ = w.Write([]byte("data: {\"type\":\"init\",\"id\":\"sess-9\"}\n\n"))
			if flusher != nil {
				flusher.Flush()
			}
			<-r.Context().Done()
		case r.Method == http.MethodDelete && r.URL.Path == "/command":
			mu.Lock()
			interrupted = r.URL.Query().Get("id")
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer execd.Close()

	adapter := runtime.NewOpenSandbox(config.OpenSandboxConfig{LifecycleBaseURL: lifecycle.URL + "/v1", ExecdPort: 44772})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := adapter.Exec(ctx, runtime.ExecRequest{SandboxID: "sbx-1", Language: "python", Code: "while True: pass"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	mu.Lock()
	got := interrupted
	mu.Unlock()
	if got != "sess-9" {
		t.Fatalf("interrupted session = %q, want sess-9", got)
	}
}
