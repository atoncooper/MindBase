package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/logger"
	"app-content-mcp/internal/mcp/tools"
	boardup "app-content-mcp/internal/upstream/board"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/server"
)

const boardSampleDoc = `{"root":{"data":{"text":"中心主题"},"children":[]}}`

// newBoardToolClient mounts only the board tool surface on a fresh MCP server
// and connects the official in-process client, so every assertion below goes
// through the real tools/call protocol (schema binding, wrap decorator,
// result serialization) rather than the unexported handler functions.
func newBoardToolClient(t *testing.T, cfg *config.Config) *mcpclient.Client {
	t.Helper()
	srv := server.NewMCPServer("app-content-mcp-tests", "0.0.0",
		server.WithRecovery(),
		// Match production: bootstrap.NewServer enables input-schema validation,
		// so schema/description mismatches must be caught here too.
		server.WithInputSchemaValidation(),
		server.WithResourceCapabilities(false, false),
	)
	tools.NewBoard(boardup.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID), cfg).Register(srv)
	return startInProcessClient(t, srv)
}

// newBoardToolUpstream starts a fake app-board and returns a configured client.
func newBoardToolUpstream(t *testing.T, handler http.HandlerFunc) *mcpclient.Client {
	t.Helper()
	ts := newTestBoardUpstream(t, handler)
	return newBoardToolClient(t, boardCfg(ts.URL))
}

// newUnconfiguredToolClient returns a client whose config lacks the API key
// and fixed uid, backed by a fake upstream that must never be called.
func newUnconfiguredToolClient(t *testing.T) *mcpclient.Client {
	t.Helper()
	ts := newTestBoardUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called when unconfigured")
	})
	return newBoardToolClient(t, &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL}})
}

func TestNotConfiguredGuard(t *testing.T) {
	c := newUnconfiguredToolClient(t)
	ctx := context.Background()

	res, err := callTool(t, c, ctx, "list_boards", nil)
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "not configured") {
		t.Errorf("want config error, got isError=%v text=%s", res.IsError, toolResultText(t, res, nil))
	}
}

func TestListBoardsValidation(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called on invalid input")
	})
	res, err := callTool(t, c, context.Background(), "list_boards", map[string]any{"kind": "doc"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "mindmap") {
		t.Errorf("want kind validation error, got %s", toolResultText(t, res, nil))
	}
}

func TestListBoardsPlain(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("page") != "3" || q.Get("page_size") != "20" || q.Get("kind") != "" {
			t.Errorf("query = %v", q)
		}
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"A","kind":"mindmap","version":1,"isPinned":false}],"total":21,"page":3,"pageSize":20}`))
	})

	res, err := callTool(t, c, context.Background(), "list_boards", map[string]any{"page": 3})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, `"total":21`) || !strings.Contains(out, `"uuid":"u1"`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestListBoardsSearch(t *testing.T) {
	// 1050 boards across 11 pages; only two titles match the needle.
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		items := make([]string, 0, 100)
		for i := 0; i < 100; i++ {
			n := (page-1)*100 + i
			title := fmt.Sprintf("board-%d", n)
			if n == 42 || n == 342 {
				title = fmt.Sprintf("needle-%d", n)
			}
			items = append(items, fmt.Sprintf(`{"uuid":"u%d","title":%q,"kind":"mindmap","version":1,"isPinned":false}`, n, title))
		}
		fmt.Fprintf(w, `{"items":[%s],"total":1050,"page":%d,"pageSize":100}`, strings.Join(items, ","), page)
	})

	res, err := callTool(t, c, context.Background(), "list_boards", map[string]any{"search": "NEEDLE-"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := toolResultText(t, res, nil)
	if !res.IsError {
		var parsed struct {
			Matched   int   `json:"matched"`
			Total     int64 `json:"total"`
			Scanned   int64 `json:"scanned"`
			Truncated bool  `json:"truncated"`
		}
		if json.Unmarshal([]byte(out), &parsed) != nil {
			t.Fatalf("output not JSON: %s", out)
		}
		if parsed.Matched != 2 || parsed.Total != 1050 || parsed.Scanned != 1000 || !parsed.Truncated {
			t.Errorf("search summary = %+v", parsed)
		}
		if !strings.Contains(out, "needle-42") || !strings.Contains(out, "needle-342") {
			t.Errorf("matches missing from output: %s", out)
		}
	}
}

func TestListBoardsSearchWithinOnePage(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			t.Errorf("must stop after page 1, requested page %s", r.URL.Query().Get("page"))
		}
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"meeting notes","kind":"mindmap","version":1,"isPinned":false}],"total":2,"page":1,"pageSize":100}`))
	})
	res, err := callTool(t, c, context.Background(), "list_boards", map[string]any{"search": "MEETING"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := toolResultText(t, res, nil)
	if strings.Contains(out, `"truncated":true`) || !strings.Contains(out, `"matched":1`) {
		t.Errorf("unexpected search output: %s", out)
	}
}

func TestGetBoardParsesContent(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("path = %s", r.URL.Path)
		}
		fmt.Fprintf(w, `{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false,"content":%q}`, boardSampleDoc)
	})

	res, err := callTool(t, c, context.Background(), "get_board", map[string]any{"board_uuid": "u-1"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := toolResultText(t, res, nil)
	// Content must be embedded as an object, not a double-encoded string.
	if !strings.Contains(out, `"content":{"root"`) || !strings.Contains(out, `"version":7`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestGetBoardUnparsableContentPassesThrough(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":1,"isPinned":false,"content":"not-json"}`))
	})
	res, err := callTool(t, c, context.Background(), "get_board", map[string]any{"board_uuid": "u-1"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, `"content":"not-json"`) {
		t.Errorf("unparsable content should pass through: %s", out)
	}
}

func TestCreateBoardContentShapes(t *testing.T) {
	objectContent := map[string]any{
		"title":   "T",
		"content": map[string]any{"root": map[string]any{"data": map[string]any{"text": "n"}}},
	}
	cases := []struct {
		name    string
		args    map[string]any
		wantSub string
	}{
		{"object content", objectContent, `"content":{"root"`},
		{"string content", map[string]any{"title": "T", "content": boardSampleDoc}, `"content":"{\"root`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), tc.wantSub) {
					t.Errorf("body = %s, want substring %s", body, tc.wantSub)
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"uuid":"new","title":"T","kind":"mindmap","version":1,"isPinned":false}`))
			})
			res, err := callTool(t, c, context.Background(), "create_board", tc.args)
			if err != nil {
				t.Fatalf("transport error: %v", err)
			}
			if res.IsError {
				t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
			}
		})
	}
}

func TestCreateBoardValidation(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called on invalid input")
	})
	res, err := callTool(t, c, context.Background(), "create_board", nil)
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "title") {
		t.Errorf("want missing-title error, got %s", toolResultText(t, res, nil))
	}
	res, err = callTool(t, c, context.Background(), "create_board", map[string]any{"title": "T", "kind": "doc"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "mindmap") {
		t.Errorf("want kind validation error, got %s", toolResultText(t, res, nil))
	}
}

func TestCreateBoardContentRejectsWrongType(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called on invalid input")
	})
	res, err := callTool(t, c, context.Background(), "create_board", map[string]any{"title": "T", "content": 123})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "input schema validation failed") {
		t.Errorf("want schema validation error, got isError=%v text=%s", res.IsError, toolResultText(t, res, nil))
	}
}

func TestUpdateBoardAutoLocksVersion(t *testing.T) {
	var sawIfMatch string
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":3,"isPinned":false}`))
		case http.MethodPut:
			sawIfMatch = r.Header.Get("If-Match")
			_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":4,"isPinned":false}`))
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	})

	res, err := callTool(t, c, context.Background(), "update_board",
		map[string]any{"board_uuid": "u-1", "title": "doc"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
	}
	if sawIfMatch != "3" {
		t.Errorf("If-Match = %q, want 3 (auto-locked)", sawIfMatch)
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, `"version":4`) || !strings.Contains(out, "末写者胜") {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestUpdateBoardExplicitVersionAndConflict(t *testing.T) {
	var sawIfMatch string
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			sawIfMatch = r.Header.Get("If-Match")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"detail":"version conflict: board was modified concurrently, reload and retry"}`))
		case http.MethodGet: // conflict path fetches the latest version
			_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false}`))
		}
	})

	res, err := callTool(t, c, context.Background(), "update_board",
		map[string]any{"board_uuid": "u-1", "expected_version": 5, "content": map[string]any{"root": map[string]any{}}})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if sawIfMatch != "5" {
		t.Errorf("If-Match = %q, want 5", sawIfMatch)
	}
	if !res.IsError {
		t.Fatalf("conflict must be a tool error, got %s", toolResultText(t, res, nil))
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, "版本冲突") || !strings.Contains(out, " 7。") {
		t.Errorf("conflict message should carry the latest version: %s", out)
	}
}

func TestUpdateBoardRequiresField(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called without fields")
	})
	res, err := callTool(t, c, context.Background(), "update_board", map[string]any{"board_uuid": "u-1"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "至少提供") {
		t.Errorf("want no-fields error, got %s", toolResultText(t, res, nil))
	}
}

func TestDeleteBoard(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	res, err := callTool(t, c, context.Background(), "delete_board", map[string]any{"board_uuid": "u-1"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, `"deleted":true`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestPinBoard(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/internal/board/boards/u-1/pin" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"T","kind":"mindmap","version":1,"isPinned":true}`))
	})

	res, err := callTool(t, c, context.Background(), "pin_board", map[string]any{"board_uuid": "u-1"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(toolResultText(t, res, nil), "is_pinned") {
		t.Errorf("want missing is_pinned error, got %s", toolResultText(t, res, nil))
	}

	res, err = callTool(t, c, context.Background(), "pin_board", map[string]any{"board_uuid": "u-1", "is_pinned": true})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, `"isPinned":true`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestNotFoundMessage(t *testing.T) {
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})
	res, err := callTool(t, c, context.Background(), "get_board", map[string]any{"board_uuid": "ghost"})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("want tool error")
	}
	if out := toolResultText(t, res, nil); !strings.Contains(out, "404") || !strings.Contains(out, "不存在") {
		t.Errorf("unexpected 404 message: %s", out)
	}
}

// ── wrap delegate (kit.Wrap via the real board tool surface) ────────

func TestWrapLogsSuccessWithRequestID(t *testing.T) {
	buf := captureSlog(t)
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"total":0,"page":1,"pageSize":20}`))
	})

	ctx := logger.IntoContext(context.Background(), "trace-xyz")
	res, err := callTool(t, c, ctx, "list_boards", map[string]any{"kind": "mindmap", "page": 2})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
	}

	out := buf.String()
	for _, want := range []string{"tool call", "tool=list_boards", "kind=mindmap", "page=2", "request_id=trace-xyz", "module=tool"} {
		if !strings.Contains(out, want) {
			t.Errorf("log line missing %q: %s", want, out)
		}
	}
}

func TestWrapLogsToolErrorAsWarn(t *testing.T) {
	buf := captureSlog(t)
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})
	res, err := callTool(t, c, context.Background(), "get_board", map[string]any{"board_uuid": "ghost"})
	if err != nil || !res.IsError {
		t.Fatalf("want tool error result, err=%v isError=%v", err, res.IsError)
	}

	out := buf.String()
	if !strings.Contains(out, "tool call failed") || !strings.Contains(out, "level=WARN") || !strings.Contains(out, "board_uuid=ghost") {
		t.Errorf("expected WARN line with uuid, got: %s", out)
	}
}

func TestWrapNeverLogsUserContent(t *testing.T) {
	buf := captureSlog(t)
	c := newBoardToolUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"uuid":"new","title":"T","kind":"mindmap","version":1,"isPinned":false}`))
	})

	secret := "机密标题内容"
	args := map[string]any{
		"title":   secret,
		"content": map[string]any{"root": map[string]any{"data": map[string]any{"text": secret}}},
	}
	res, err := callTool(t, c, context.Background(), "create_board", args)
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", toolResultText(t, res, nil))
	}

	out := buf.String()
	if strings.Contains(out, secret) {
		t.Errorf("user content leaked into logs: %s", out)
	}
	if !strings.Contains(out, "title_len=") || !strings.Contains(out, "content_bytes=") {
		t.Errorf("size signals missing from log line: %s", out)
	}
}
