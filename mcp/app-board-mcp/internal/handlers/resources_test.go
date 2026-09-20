package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"app-board-mcp/internal/config"
	"app-board-mcp/internal/upstream"

	"github.com/mark3labs/mcp-go/mcp"
)

func readReq(uri string) mcp.ReadResourceRequest {
	return mcp.ReadResourceRequest{Params: mcp.ReadResourceParams{URI: uri}}
}

func TestReadBoardResourceHappy(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("path = %s", r.URL.Path)
		}
		fmt.Fprintf(w, `{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false,"content":%q}`, sampleDoc)
	})

	res, err := tool.readBoardResource(context.Background(), readReq("board://u-1"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	tc, ok := res[0].(mcp.TextResourceContents)
	if !ok {
		t.Fatalf("want TextResourceContents, got %T", res[0])
	}
	if tc.URI != "board://u-1" || tc.MIMEType != "application/json" {
		t.Errorf("contents = %+v", tc)
	}
	// Wrapper must carry metadata and the parsed (not double-encoded) content.
	for _, want := range []string{`"uuid":"u-1"`, `"version":7`, `"content":{"root"`} {
		if !strings.Contains(tc.Text, want) {
			t.Errorf("payload missing %q: %s", want, tc.Text)
		}
	}
}

func TestReadBoardResourceErrors(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})

	if _, err := tool.readBoardResource(context.Background(), readReq("board://ghost")); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("404 should surface as error, got %v", err)
	}
	if _, err := tool.readBoardResource(context.Background(), readReq("board://")); err == nil || !strings.Contains(err.Error(), "board://") {
		t.Errorf("empty uuid should be rejected, got %v", err)
	}
	if _, err := tool.readBoardResource(context.Background(), readReq("board://a/b")); err == nil {
		t.Error("nested URI path should be rejected")
	}
}

func TestReadBoardResourceNotConfigured(t *testing.T) {
	ts := newUnconfiguredServer(t)
	tool := New(upstream.NewClient(ts.URL, "", 0), &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL}})
	if _, err := tool.readBoardResource(context.Background(), readReq("board://u-1")); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Errorf("want config error, got %v", err)
	}
}

func TestInjectListResultsHappy(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"A","kind":"mindmap","version":2,"isPinned":false},{"uuid":"u2","title":"B","kind":"whiteboard","version":1,"isPinned":true}],"total":2,"page":1,"pageSize":100}`))
	})
	result := &mcp.ListResourcesResult{}
	tool.injectListResults(context.Background(), nil, nil, result)

	if len(result.Resources) != 2 {
		t.Fatalf("injected = %d, want 2", len(result.Resources))
	}
	if result.Resources[0].URI != "board://u1" || result.Resources[0].MIMEType != "application/json" {
		t.Errorf("resource = %+v", result.Resources[0])
	}
}

func TestInjectListResultsTruncated(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		items := make([]string, 0, 100)
		for i := 0; i < 100; i++ {
			n := (page-1)*100 + i
			items = append(items, fmt.Sprintf(`{"uuid":"u%d","title":"T%d","kind":"mindmap","version":1,"isPinned":false}`, n, n))
		}
		fmt.Fprintf(w, `{"items":[%s],"total":1050,"page":%d,"pageSize":100}`, strings.Join(items, ","), page)
	})
	result := &mcp.ListResourcesResult{}
	tool.injectListResults(context.Background(), nil, nil, result)

	if len(result.Resources) != 1000 {
		t.Fatalf("injected = %d, want 1000", len(result.Resources))
	}
	if last := result.Resources[len(result.Resources)-1]; !strings.Contains(last.Description, "list_boards") {
		t.Errorf("truncation hint missing on last entry: %s", last.Description)
	}
}

func TestInjectListResultsBestEffort(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"internal storage error","request_id":"x"}`))
	})
	result := &mcp.ListResourcesResult{}
	tool.injectListResults(context.Background(), nil, nil, result) // must not panic
	if len(result.Resources) != 0 {
		t.Errorf("upstream failure should inject nothing, got %d", len(result.Resources))
	}
}

func TestInjectListResultsNotConfigured(t *testing.T) {
	ts := newUnconfiguredServer(t)
	tool := New(upstream.NewClient(ts.URL, "", 0), &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL}})
	result := &mcp.ListResourcesResult{}
	tool.injectListResults(context.Background(), nil, nil, result)
	if len(result.Resources) != 0 {
		t.Errorf("unconfigured must inject nothing, got %d", len(result.Resources))
	}
}
