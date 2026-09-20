package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"app-board-mcp/internal/config"
	"app-board-mcp/internal/logger"
	"app-board-mcp/internal/upstream"

	"github.com/mark3labs/mcp-go/mcp"
)

// captureSlog swaps the default slog logger for a text handler writing to a
// buffer, restoring the previous default on test cleanup. The handler is
// wrapped in logger.NewContextHandler exactly like logger.New does in main,
// so request_id injection behaves as in production.
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	h := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	slog.SetDefault(slog.New(logger.NewContextHandler(h)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// newRegistry builds a Tools wired to a fake app-board served by handler.
func newRegistry(t *testing.T, handler http.HandlerFunc) (*Registry, *httptest.Server) {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	cfg := &config.Config{
		Upstream: config.UpstreamConfig{BaseURL: ts.URL, APIKey: "test-key", UID: 42},
	}
	return New(upstream.NewClient(ts.URL, "test-key", 42), cfg), ts
}

func callReq(name string, args map[string]any) mcp.CallToolRequest {
	return mcp.CallToolRequest{Params: mcp.CallToolParams{Name: name, Arguments: args}}
}

// newUnconfiguredServer returns an unused fake upstream for guard tests.
func newUnconfiguredServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called when unconfigured")
	}))
	t.Cleanup(ts.Close)
	return ts
}

func resultText(t *testing.T, res *mcp.CallToolResult, err error) string {
	t.Helper()
	if err != nil {
		t.Fatalf("handler returned transport error: %v", err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("want one content block, got %d", len(res.Content))
	}
	text, ok := res.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("want TextContent, got %T", res.Content[0])
	}
	return text.Text
}

const sampleDoc = `{"root":{"data":{"text":"中心主题"},"children":[]}}`

func TestNotConfiguredGuard(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called when unconfigured")
	}))
	defer ts.Close()

	cfg := &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL}}
	tool := New(upstream.NewClient(ts.URL, "", 0), cfg)

	res, err := tool.listBoards(context.Background(), callReq("list_boards", nil))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "not configured") {
		t.Errorf("want config error, got isError=%v text=%s", res.IsError, resultText(t, res, nil))
	}
}

func TestListBoardsValidation(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called on invalid input")
	})
	res, _ := tool.listBoards(context.Background(), callReq("list_boards", map[string]any{"kind": "doc"}))
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "mindmap") {
		t.Errorf("want kind validation error, got %s", resultText(t, res, nil))
	}
}

func TestListBoardsPlain(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("page") != "3" || q.Get("page_size") != "20" || q.Get("kind") != "" {
			t.Errorf("query = %v", q)
		}
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"A","kind":"mindmap","version":1,"isPinned":false}],"total":21,"page":3,"pageSize":20}`))
	})

	res, err := tool.listBoards(context.Background(), callReq("list_boards", map[string]any{"page": 3}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
	}
	if out := resultText(t, res, nil); !strings.Contains(out, `"total":21`) || !strings.Contains(out, `"uuid":"u1"`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestListBoardsSearch(t *testing.T) {
	// 1050 boards across 11 pages; only two titles match the needle.
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
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

	res, err := tool.listBoards(context.Background(), callReq("list_boards", map[string]any{"search": "NEEDLE-"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := resultText(t, res, nil)
	if !res.IsError {
		var parsed struct {
			Matched   int    `json:"matched"`
			Total     int64  `json:"total"`
			Scanned   int64  `json:"scanned"`
			Truncated bool   `json:"truncated"`
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
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			t.Errorf("must stop after page 1, requested page %s", r.URL.Query().Get("page"))
		}
		_, _ = w.Write([]byte(`{"items":[{"uuid":"u1","title":"meeting notes","kind":"mindmap","version":1,"isPinned":false}],"total":2,"page":1,"pageSize":100}`))
	})
	res, err := tool.listBoards(context.Background(), callReq("list_boards", map[string]any{"search": "MEETING"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := resultText(t, res, nil)
	if strings.Contains(out, `"truncated":true`) || !strings.Contains(out, `"matched":1`) {
		t.Errorf("unexpected search output: %s", out)
	}
}

func TestGetBoardParsesContent(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("path = %s", r.URL.Path)
		}
		fmt.Fprintf(w, `{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false,"content":%q}`, sampleDoc)
	})

	res, err := tool.getBoard(context.Background(), callReq("get_board", map[string]any{"board_uuid": "u-1"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	out := resultText(t, res, nil)
	// Content must be embedded as an object, not a double-encoded string.
	if !strings.Contains(out, `"content":{"root"`) || !strings.Contains(out, `"version":7`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestGetBoardUnparsableContentPassesThrough(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":1,"isPinned":false,"content":"not-json"}`))
	})
	res, err := tool.getBoard(context.Background(), callReq("get_board", map[string]any{"board_uuid": "u-1"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if out := resultText(t, res, nil); !strings.Contains(out, `"content":"not-json"`) {
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
		{"string content", map[string]any{"title": "T", "content": sampleDoc}, `"content":"{\"root\"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
				buf := make([]byte, r.ContentLength)
				_, _ = r.Body.Read(buf)
				if !strings.Contains(string(buf), tc.wantSub) {
					t.Errorf("body = %s, want substring %s", buf, tc.wantSub)
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"uuid":"new","title":"T","kind":"mindmap","version":1,"isPinned":false}`))
			})
			res, err := tool.createBoard(context.Background(), callReq("create_board", tc.args))
			if err != nil {
				t.Fatalf("transport error: %v", err)
			}
			if res.IsError {
				t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
			}
		})
	}
}

func TestCreateBoardValidation(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called on invalid input")
	})
	res, _ := tool.createBoard(context.Background(), callReq("create_board", nil))
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "title") {
		t.Errorf("want missing-title error, got %s", resultText(t, res, nil))
	}
	res, _ = tool.createBoard(context.Background(), callReq("create_board", map[string]any{"title": "T", "kind": "doc"}))
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "mindmap") {
		t.Errorf("want kind validation error, got %s", resultText(t, res, nil))
	}
}

func TestUpdateBoardAutoLocksVersion(t *testing.T) {
	var sawIfMatch string
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
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

	res, err := tool.updateBoard(context.Background(), callReq("update_board",
		map[string]any{"board_uuid": "u-1", "title": "doc"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
	}
	if sawIfMatch != "3" {
		t.Errorf("If-Match = %q, want 3 (auto-locked)", sawIfMatch)
	}
	if out := resultText(t, res, nil); !strings.Contains(out, `"version":4`) || !strings.Contains(out, "末写者胜") {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestUpdateBoardExplicitVersionAndConflict(t *testing.T) {
	var sawIfMatch string
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			sawIfMatch = r.Header.Get("If-Match")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"detail":"version conflict: board was modified concurrently, reload and retry"}`))
		case http.MethodGet: // conflict path fetches the latest version
			_, _ = w.Write([]byte(`{"uuid":"u-1","title":"doc","kind":"mindmap","version":7,"isPinned":false}`))
		}
	})

	res, err := tool.updateBoard(context.Background(), callReq("update_board",
		map[string]any{"board_uuid": "u-1", "expected_version": 5, "content": map[string]any{"root": map[string]any{}}}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if sawIfMatch != "5" {
		t.Errorf("If-Match = %q, want 5", sawIfMatch)
	}
	if !res.IsError {
		t.Fatalf("conflict must be a tool error, got %s", resultText(t, res, nil))
	}
	if out := resultText(t, res, nil); !strings.Contains(out, "版本冲突") || !strings.Contains(out, " 7。") {
		t.Errorf("conflict message should carry the latest version: %s", out)
	}
}

func TestUpdateBoardRequiresField(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be called without fields")
	})
	res, _ := tool.updateBoard(context.Background(), callReq("update_board", map[string]any{"board_uuid": "u-1"}))
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "至少提供") {
		t.Errorf("want no-fields error, got %s", resultText(t, res, nil))
	}
}

func TestDeleteBoard(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/internal/board/boards/u-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	res, err := tool.deleteBoard(context.Background(), callReq("delete_board", map[string]any{"board_uuid": "u-1"}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if out := resultText(t, res, nil); !strings.Contains(out, `"deleted":true`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestPinBoard(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/internal/board/boards/u-1/pin" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"uuid":"u-1","title":"T","kind":"mindmap","version":1,"isPinned":true}`))
	})

	res, _ := tool.pinBoard(context.Background(), callReq("pin_board", map[string]any{"board_uuid": "u-1"}))
	if !res.IsError || !strings.Contains(resultText(t, res, nil), "is_pinned") {
		t.Errorf("want missing is_pinned error, got %s", resultText(t, res, nil))
	}

	res, err := tool.pinBoard(context.Background(), callReq("pin_board", map[string]any{"board_uuid": "u-1", "is_pinned": true}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
	}
	if out := resultText(t, res, nil); !strings.Contains(out, `"isPinned":true`) {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestNotFoundMessage(t *testing.T) {
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})
	res, _ := tool.getBoard(context.Background(), callReq("get_board", map[string]any{"board_uuid": "ghost"}))
	if !res.IsError {
		t.Fatalf("want tool error")
	}
	if out := resultText(t, res, nil); !strings.Contains(out, "404") || !strings.Contains(out, "不存在") {
		t.Errorf("unexpected 404 message: %s", out)
	}
}

func TestWrapLogsSuccessWithRequestID(t *testing.T) {
	buf := captureSlog(t)
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"total":0,"page":1,"pageSize":20}`))
	})
	wrapped := tool.wrap("list_boards", tool.listBoards)

	ctx := logger.IntoContext(context.Background(), "trace-xyz")
	res, err := wrapped(ctx, callReq("list_boards", map[string]any{"kind": "mindmap", "page": 2}))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
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
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"board not found"}`))
	})
	wrapped := tool.wrap("get_board", tool.getBoard)
	res, err := wrapped(context.Background(), callReq("get_board", map[string]any{"board_uuid": "ghost"}))
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
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"uuid":"new","title":"T","kind":"mindmap","version":1,"isPinned":false}`))
	})
	wrapped := tool.wrap("create_board", tool.createBoard)

	secret := "机密标题内容"
	args := map[string]any{
		"title":   secret,
		"content": map[string]any{"root": map[string]any{"data": map[string]any{"text": secret}}},
	}
	res, err := wrapped(context.Background(), callReq("create_board", args))
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", resultText(t, res, nil))
	}

	out := buf.String()
	if strings.Contains(out, secret) {
		t.Errorf("user content leaked into logs: %s", out)
	}
	if !strings.Contains(out, "title_len=") || !strings.Contains(out, "content_bytes=") {
		t.Errorf("size signals missing from log line: %s", out)
	}
}

func TestWrapRecoversPanic(t *testing.T) {
	buf := captureSlog(t)
	tool, _ := newRegistry(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("upstream must not be reached when the handler panics")
	})
	wrapped := tool.wrap("boom", func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		panic("exploded")
	})

	res, err := wrapped(context.Background(), callReq("boom", nil))
	if err == nil || !strings.Contains(err.Error(), "panic") {
		t.Fatalf("panic must become a handler error, got err=%v res=%v", err, res)
	}
	if !strings.Contains(buf.String(), "tool panicked") || !strings.Contains(buf.String(), "exploded") {
		t.Errorf("panic not logged: %s", buf.String())
	}
}
