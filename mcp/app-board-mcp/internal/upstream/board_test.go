package upstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-board-mcp/internal/identity"
	"app-board-mcp/internal/logger"
)

const testDoc = `{"root":{"data":{"text":"root"},"children":[]}}`

func testClient(t *testing.T, ts *httptest.Server) *Client {
	t.Helper()
	return NewClient(ts.URL, "test-key", 42)
}

// checkAuthHeaders asserts the identity headers every request must carry.
func checkAuthHeaders(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get("apikey"); got != "test-key" {
		t.Errorf("apikey header = %q, want test-key", got)
	}
	if got := r.Header.Get("X-Uid"); got != "42" {
		t.Errorf("X-Uid header = %q, want 42", got)
	}
	if got := r.Header.Get("X-Request-Id"); got == "" {
		t.Error("X-Request-Id header is empty")
	}
}

func TestList(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkAuthHeaders(t, r)
		if r.URL.Path != "/internal/board/boards" {
			t.Errorf("path = %q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("page") != "2" || q.Get("page_size") != "50" || q.Get("kind") != "mindmap" {
			t.Errorf("query = %v", q)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"A","kind":"mindmap","version":3,"isPinned":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}],"total":1,"page":2,"pageSize":50}`))
	}))
	defer ts.Close()

	list, err := testClient(t, ts).List(context.Background(), "mindmap", 2, 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].UUID != "u1" || !list.Items[0].IsPinned || list.Items[0].Version != 3 {
		t.Errorf("unexpected list: %+v", list)
	}
}

func TestGet(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkAuthHeaders(t, r)
		if r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","content":"{\"root\":{}}"}`))
	}))
	defer ts.Close()

	detail, err := testClient(t, ts).Get(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if detail.Version != 7 || detail.Content == nil || *detail.Content != `{"root":{}}` {
		t.Errorf("unexpected detail: %+v", detail)
	}
}

func TestCreateContentShapes(t *testing.T) {
	// Object content must arrive as a raw object token; string content stays
	// a JSON string (app-board stores either verbatim).
	stringToken, _ := json.Marshal(testDoc) // properly escaped JSON string
	cases := []struct {
		name    string
		content json.RawMessage
		want    string // substring of the request body
	}{
		{"object", json.RawMessage(`{"root":{"data":{"text":"n"}}}`), `"content":{"root":{"data":{"text":"n"}}}`},
		{"string", stringToken, `"content":"{\"root\":{`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), tc.want) {
					t.Errorf("body = %s, want substring %s", body, tc.want)
				}
				if r.Header.Get("Content-Type") != "application/json" {
					t.Error("missing content-type")
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"uuid":"new","title":"T","kind":"mindmap","version":1,"isPinned":false}`))
			}))
			defer ts.Close()

			meta, err := testClient(t, ts).Create(context.Background(), CreateBody{Title: "T", Kind: "mindmap", Content: tc.content})
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			if meta.UUID != "new" || meta.Version != 1 {
				t.Errorf("unexpected meta: %+v", meta)
			}
		})
	}
}

func TestUpdateIfMatchAndOmits(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkAuthHeaders(t, r)
		if r.Method != http.MethodPut || r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("If-Match"); got != "7" {
			t.Errorf("If-Match = %q, want 7", got)
		}
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "isPinned") {
			t.Errorf("nil isPinned must be omitted, body = %s", body)
		}
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"T2","kind":"mindmap","version":8,"isPinned":false}`))
	}))
	defer ts.Close()

	title := "T2"
	meta, err := testClient(t, ts).Update(context.Background(), "u-1", 7, UpdateBody{Title: &title})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if meta.Version != 8 {
		t.Errorf("version = %d, want 8", meta.Version)
	}
}

func TestDeleteAndPin(t *testing.T) {
	var pinBody string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkAuthHeaders(t, r)
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/internal/board/boards/u-1":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch && r.URL.Path == "/internal/board/boards/u-1/pin":
			b, _ := io.ReadAll(r.Body)
			pinBody = string(b)
			_, _ = w.Write([]byte(`{"uuid":"u-1","title":"T","kind":"mindmap","version":8,"isPinned":true}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer ts.Close()

	c := testClient(t, ts)
	if err := c.Delete(context.Background(), "u-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	meta, err := c.SetPin(context.Background(), "u-1", true)
	if err != nil {
		t.Fatalf("SetPin: %v", err)
	}
	if !meta.IsPinned {
		t.Errorf("meta = %+v, want pinned", meta)
	}
	if pinBody != `{"isPinned":true}` {
		t.Errorf("pin body = %s", pinBody)
	}
}

func TestErrorEnvelope(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"internal storage error","request_id":"abc123"}`))
	}))
	defer ts.Close()

	_, err := testClient(t, ts).Get(context.Background(), "u-1")
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("want *APIError, got %T: %v", err, err)
	}
	if apiErr.Status != 500 || apiErr.Detail != "internal storage error" || apiErr.RequestID != "abc123" {
		t.Errorf("apiErr = %+v", apiErr)
	}
	if !strings.Contains(err.Error(), "request_id: abc123") {
		t.Errorf("Error() should carry request_id: %v", err)
	}
}

func TestErrorFallbackAndPredicates(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/board/boards/conflict":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"detail":"version conflict: board was modified concurrently, reload and retry"}`))
		case "/internal/board/boards/missing":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":"board not found"}`))
		case "/internal/board/boards/raw":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`<html>bad gateway</html>`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer ts.Close()

	c := testClient(t, ts)
	ctx := context.Background()

	_, err := c.Get(ctx, "conflict")
	if !ErrConflict(err) {
		t.Errorf("conflict predicate failed for %v", err)
	}
	_, err = c.Get(ctx, "missing")
	if !ErrNotFound(err) {
		t.Errorf("not-found predicate failed for %v", err)
	}
	_, err = c.Get(ctx, "raw")
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Detail == "" || apiErr.RequestID != "" {
		t.Errorf("non-JSON error should fall back to status text: %+v", err)
	}
}

func TestUnreachable(t *testing.T) {
	// Port 1 is never listening in the test environment.
	c := NewClient("http://127.0.0.1:1", "k", 1)
	_, err := c.List(context.Background(), "", 1, 20)
	if err == nil || !strings.Contains(err.Error(), "gateway unreachable") {
		t.Errorf("want unreachable error, got %v", err)
	}
}

func TestRequestIDFromContext(t *testing.T) {
	// A request id injected into ctx (tools layer / HTTP middleware) must be
	// reused as the upstream X-Request-Id for end-to-end log correlation.
	var seen string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Request-Id")
		_, _ = w.Write([]byte(`{"items":[],"total":0,"page":1,"pageSize":20}`))
	}))
	defer ts.Close()

	ctx := logger.IntoContext(context.Background(), "trace-abc")
	if _, err := testClient(t, ts).List(ctx, "", 1, 20); err != nil {
		t.Fatalf("List: %v", err)
	}
	if seen != "trace-abc" {
		t.Errorf("X-Request-Id = %q, want trace-abc", seen)
	}
}

func TestRequestIDGeneratedWhenAbsent(t *testing.T) {
	var seen string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Request-Id")
		_, _ = w.Write([]byte(`{"items":[],"total":0,"page":1,"pageSize":20}`))
	}))
	defer ts.Close()

	if _, err := testClient(t, ts).List(context.Background(), "", 1, 20); err != nil {
		t.Fatalf("List: %v", err)
	}
	if seen == "" || seen == "-" {
		t.Errorf("X-Request-Id must be generated, got %q", seen)
	}
}

func TestActingUIDFromIdentityContext(t *testing.T) {
	// Service mode: the uid in ctx (per-request, from the main-app backend)
	// must override the client's configured default in the upstream X-Uid.
	var seen string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Uid")
		_, _ = w.Write([]byte(`{"items":[],"total":0,"page":1,"pageSize":20}`))
	}))
	defer ts.Close()

	ctx := identity.IntoContext(context.Background(), 777)
	if _, err := testClient(t, ts).List(ctx, "", 1, 20); err != nil {
		t.Fatalf("List: %v", err)
	}
	if seen != "777" {
		t.Errorf("X-Uid = %q, want 777", seen)
	}

	// No identity in ctx -> configured default uid (bearer clients).
	if _, err := testClient(t, ts).List(context.Background(), "", 1, 20); err != nil {
		t.Fatalf("List: %v", err)
	}
	if seen != "42" {
		t.Errorf("X-Uid fallback = %q, want 42 (client default)", seen)
	}
}
