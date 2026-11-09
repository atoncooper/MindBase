package tests

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/identity"
	"app-content-mcp/internal/logger"
	"app-content-mcp/internal/mcp/kit"

	"github.com/mark3labs/mcp-go/mcp"
)

func noSafeArgs(mcp.CallToolRequest) []slog.Attr { return nil }

// TestBearerAllowlist pins the least-privilege rule introduced with the 3→1
// merge: an external bearer token may be restricted to a tool subset, while
// service-mode callers (app-ts, per-request X-Uid) keep the full 12 tools.
// It goes through the exported kit.Wrap decorator directly because the rule
// lives there, not in any single handler.
func TestBearerAllowlist(t *testing.T) {
	cfg := &config.Config{
		Server:   config.ServerConfig{BearerAllowedTools: []string{"list_boards"}},
		Upstream: config.UpstreamConfig{APIKey: "k", UID: 7},
	}
	called := 0
	h := func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		called++
		return kit.Text("ok"), nil
	}

	// bearer + disallowed tool → denied before the handler runs
	res, err := kit.Wrap("delete_board", noSafeArgs, cfg, h)(identity.IntoBearerContext(context.Background()), mcp.CallToolRequest{})
	if err != nil {
		t.Fatalf("denied call returned transport error: %v", err)
	}
	if res == nil || !res.IsError || called != 0 {
		t.Fatalf("bearer delete_board should be denied: res=%+v called=%d", res, called)
	}

	// bearer + allowlisted tool → allowed through
	if res, err = kit.Wrap("list_boards", noSafeArgs, cfg, h)(identity.IntoBearerContext(context.Background()), mcp.CallToolRequest{}); err != nil || res.IsError || called != 1 {
		t.Fatalf("bearer list_boards should pass: res=%+v err=%v called=%d", res, err, called)
	}

	// service mode is never restricted
	ctx := identity.IntoContext(context.Background(), 42)
	if res, err = kit.Wrap("delete_board", noSafeArgs, cfg, h)(ctx, mcp.CallToolRequest{}); err != nil || res.IsError || called != 2 {
		t.Fatalf("service-mode delete_board should pass: res=%+v err=%v called=%d", res, err, called)
	}

	// empty allowlist = unrestricted bearer (legacy behaviour)
	open := &config.Config{Upstream: config.UpstreamConfig{APIKey: "k", UID: 7}}
	if res, err = kit.Wrap("delete_board", noSafeArgs, open, h)(identity.IntoBearerContext(context.Background()), mcp.CallToolRequest{}); err != nil || res.IsError || called != 3 {
		t.Fatalf("empty allowlist should allow: res=%+v err=%v called=%d", res, err, called)
	}
}

// TestWrapRecoversPanic pins the decorator contract for a panicking handler:
// the panic never escapes to the MCP runtime, it becomes a handler error, and
// the stack is logged.
func TestWrapRecoversPanic(t *testing.T) {
	buf := captureSlog(t)
	cfg := &config.Config{Upstream: config.UpstreamConfig{APIKey: "k", UID: 42}}
	wrapped := kit.Wrap("boom", noSafeArgs, cfg, func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		panic("exploded")
	})

	res, err := wrapped(context.Background(), mcp.CallToolRequest{})
	if err == nil || !strings.Contains(err.Error(), "panic") {
		t.Fatalf("panic must become a handler error, got err=%v res=%v", err, res)
	}
	if !strings.Contains(buf.String(), "tool panicked") || !strings.Contains(buf.String(), "exploded") {
		t.Errorf("panic not logged: %s", buf.String())
	}
}

// TestKitWrapLogsSuccessWithRequestID pins the decorator's normal path through
// the exported kit.Wrap: the caller-supplied safe args and the request id
// from ctx are logged, and the handler result is passed through untouched.
func TestKitWrapLogsSuccessWithRequestID(t *testing.T) {
	buf := captureSlog(t)
	cfg := &config.Config{Upstream: config.UpstreamConfig{APIKey: "k", UID: 42}}
	safeArgs := func(req mcp.CallToolRequest) []slog.Attr {
		if v, ok := req.GetArguments()["board_uuid"].(string); ok {
			return []slog.Attr{slog.String("board_uuid", v)}
		}
		return nil
	}
	wrapped := kit.Wrap("list_boards", safeArgs, cfg, func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return kit.Text(`{"items":[],"total":0}`), nil
	})

	ctx := logger.IntoContext(context.Background(), "trace-xyz")
	res, err := wrapped(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"board_uuid": "u-1"}}})
	if err != nil {
		t.Fatalf("transport error: %v", err)
	}
	if res == nil || res.IsError || kit.FirstText(res) != `{"items":[],"total":0}` {
		t.Fatalf("result not passed through: %+v", res)
	}

	out := buf.String()
	for _, want := range []string{"tool call", "tool=list_boards", "board_uuid=u-1", "request_id=trace-xyz", "module=tool"} {
		if !strings.Contains(out, want) {
			t.Errorf("log line missing %q: %s", want, out)
		}
	}
}
