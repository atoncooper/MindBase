package tests

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/mcp/resources"
	boardup "app-content-mcp/internal/upstream/board"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// newBoardResourceClient mounts the board resources primitive (template +
// request-time resources/list hook) and connects the official in-process
// client, so reads and listings travel over the MCP protocol.
func newBoardResourceClient(t *testing.T, cfg *config.Config) *mcpclient.Client {
	t.Helper()
	hooks := &server.Hooks{}
	srv := server.NewMCPServer("app-content-mcp-tests", "0.0.0",
		server.WithRecovery(),
		server.WithResourceCapabilities(false, false),
		server.WithHooks(hooks),
	)
	resources.NewBoard(boardup.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID), cfg).
		RegisterResources(srv, hooks)
	return startInProcessClient(t, srv)
}

// newBoardResourceUpstream starts a fake app-board and returns a client.
func newBoardResourceUpstream(t *testing.T, handler http.HandlerFunc) *mcpclient.Client {
	t.Helper()
	ts := newTestBoardUpstream(t, handler)
	return newBoardResourceClient(t, boardCfg(ts.URL))
}

func newUnconfiguredResourceClient(t *testing.T) *mcpclient.Client {
	t.Helper()
	ts := newTestBoardUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called when unconfigured")
	})
	return newBoardResourceClient(t, &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL}})
}

func readBoardResource(t *testing.T, c *mcpclient.Client, uri string) (*mcp.ReadResourceResult, error) {
	t.Helper()
	return c.ReadResource(context.Background(), mcp.ReadResourceRequest{
		Params: mcp.ReadResourceParams{URI: uri},
	})
}

func TestReadBoardResourceHappy(t *testing.T) {
	c := newBoardResourceUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("path = %s", r.URL.Path)
		}
		fmt.Fprintf(w, `{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false,"content":%q}`, boardSampleDoc)
	})

	res, err := readBoardResource(t, c, "board://u-1")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(res.Contents) != 1 {
		t.Fatalf("contents = %d, want 1", len(res.Contents))
	}
	tc, ok := res.Contents[0].(mcp.TextResourceContents)
	if !ok {
		t.Fatalf("want TextResourceContents, got %T", res.Contents[0])
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
	c := newBoardResourceUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})

	if _, err := readBoardResource(t, c, "board://ghost"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("404 should surface as error, got %v", err)
	}
	if _, err := readBoardResource(t, c, "board://"); err == nil || !strings.Contains(err.Error(), "board://") {
		t.Errorf("empty uuid should be rejected, got %v", err)
	}
	if _, err := readBoardResource(t, c, "board://a/b"); err == nil {
		t.Error("nested URI path should be rejected")
	}
}

func TestReadBoardResourceNotConfigured(t *testing.T) {
	c := newUnconfiguredResourceClient(t)
	if _, err := readBoardResource(t, c, "board://u-1"); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Errorf("want config error, got %v", err)
	}
}

func listBoardResources(t *testing.T, c *mcpclient.Client) *mcp.ListResourcesResult {
	t.Helper()
	result, err := c.ListResources(context.Background(), mcp.ListResourcesRequest{})
	if err != nil {
		t.Fatalf("list resources: %v", err)
	}
	return result
}

func TestListBoardResourcesHappy(t *testing.T) {
	c := newBoardResourceUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"A","kind":"mindmap","version":2,"isPinned":false},{"uuid":"u2","title":"B","kind":"whiteboard","version":1,"isPinned":true}],"total":2,"page":1,"pageSize":100}`))
	})
	result := listBoardResources(t, c)

	if len(result.Resources) != 2 {
		t.Fatalf("injected = %d, want 2", len(result.Resources))
	}
	if result.Resources[0].URI != "board://u1" || result.Resources[0].MIMEType != "application/json" {
		t.Errorf("resource = %+v", result.Resources[0])
	}
}

func TestListBoardResourcesTruncated(t *testing.T) {
	c := newBoardResourceUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		items := make([]string, 0, 100)
		for i := 0; i < 100; i++ {
			n := (page-1)*100 + i
			items = append(items, fmt.Sprintf(`{"uuid":"u%d","title":"T%d","kind":"mindmap","version":1,"isPinned":false}`, n, n))
		}
		fmt.Fprintf(w, `{"items":[%s],"total":1050,"page":%d,"pageSize":100}`, strings.Join(items, ","), page)
	})
	result := listBoardResources(t, c)

	if len(result.Resources) != 1000 {
		t.Fatalf("injected = %d, want 1000", len(result.Resources))
	}
	if last := result.Resources[len(result.Resources)-1]; !strings.Contains(last.Description, "list_boards") {
		t.Errorf("truncation hint missing on last entry: %s", last.Description)
	}
}

func TestListBoardResourcesBestEffort(t *testing.T) {
	c := newBoardResourceUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"internal storage error","request_id":"x"}`))
	})
	result := listBoardResources(t, c) // must not fail the list request
	if len(result.Resources) != 0 {
		t.Errorf("upstream failure should inject nothing, got %d", len(result.Resources))
	}
}

func TestListBoardResourcesNotConfigured(t *testing.T) {
	c := newUnconfiguredResourceClient(t)
	result := listBoardResources(t, c)
	if len(result.Resources) != 0 {
		t.Errorf("unconfigured must inject nothing, got %d", len(result.Resources))
	}
}
