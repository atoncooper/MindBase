package tests

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/logger"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Shared constants for the fake upstream used by the tools/resources tests.
const (
	testAPIKey = "test-key"
	testUID    = int64(42)
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

// startInProcessClient connects an official in-process MCP client to srv and
// completes the initialize handshake, so tests exercise the real MCP protocol
// (tool/resource/prompt dispatch, hooks, result serialization) instead of
// calling unexported handlers directly.
func startInProcessClient(t *testing.T, srv *server.MCPServer) *mcpclient.Client {
	t.Helper()
	c, err := mcpclient.NewInProcessClient(srv)
	if err != nil {
		t.Fatalf("new in-process client: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })

	if err := c.Start(context.Background()); err != nil {
		t.Fatalf("start client: %v", err)
	}
	initReq := mcp.InitializeRequest{}
	initReq.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	initReq.Params.ClientInfo = mcp.Implementation{Name: "app-content-mcp-tests", Version: "1.0.0"}
	if _, err := c.Initialize(context.Background(), initReq); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	return c
}

// callTool invokes a tool through the MCP protocol.
func callTool(t *testing.T, c *mcpclient.Client, ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, error) {
	t.Helper()
	return c.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: name, Arguments: args}})
}

// toolResultText asserts a successful transport call with a single text block
// and returns that text.
func toolResultText(t *testing.T, res *mcp.CallToolResult, err error) string {
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

// newTestBoardClient starts a fake app-board upstream and returns its URL.
func newTestBoardUpstream(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return ts
}

// boardCfg is the minimal configured upstream the handlers' notConfigured
// guard expects (API key + fixed uid).
func boardCfg(baseURL string) *config.Config {
	return &config.Config{Upstream: config.UpstreamConfig{
		BaseURL: baseURL, APIKey: testAPIKey, UID: testUID,
	}}
}
