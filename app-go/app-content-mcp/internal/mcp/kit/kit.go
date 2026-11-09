// Package kit holds the MCP-primitive-agnostic helpers shared by the tools,
// resources and prompts packages: result constructors, the per-call wrapper
// (request-id reuse + panic recovery + one structured log line) and the
// not-configured guard.
package kit

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/identity"
	"app-content-mcp/internal/logger"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Text returns a successful tool result.
func Text(msg string) *mcp.CallToolResult { return mcp.NewToolResultText(msg) }

// Error returns a tool-level error result the model can read and react to.
func Error(msg string) *mcp.CallToolResult { return mcp.NewToolResultError(msg) }

// FirstText returns the first text content block of a tool result ("" when absent).
func FirstText(res *mcp.CallToolResult) string {
	if res == nil {
		return ""
	}
	for _, c := range res.Content {
		if tc, ok := c.(mcp.TextContent); ok {
			return tc.Text
		}
	}
	return ""
}

// TruncateRunes truncates s to n runes (UTF-8 safe).
func TruncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// Wrap decorates one tool handler with the cross-cutting concerns shared by
// every content-domain tool:
//
//   - request id: reused from ctx when present (HTTP middleware); generated
//     per call otherwise (stdio). The id flows into every log line here AND
//     into the upstream X-Request-Id, so one agent action is one trace.
//   - panic recovery: logged with stack, converted to a tool error result.
//   - one structured log line per call: safeArgs supplies the domain-specific
//     loggable arguments (ids/flags/sizes only — never user content).
func Wrap(toolName string, safeArgs func(mcp.CallToolRequest) []slog.Attr, cfg *config.Config, h server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (res *mcp.CallToolResult, err error) {
		start := time.Now()
		if logger.FromContext(ctx) == logger.DefaultRequestID {
			ctx = logger.IntoContext(ctx, uuid.NewString())
		}

		// Least privilege for external hosts: after the 3→1 merge a single
		// bearer token fronts all 12 tools, so an allowlist can pin it to the
		// subset it needs (empty allowlist = unrestricted, legacy behaviour).
		// Service-mode callers (app-ts) are never restricted.
		if identity.ModeFromContext(ctx) == identity.ModeBearer && !cfg.BearerToolAllowed(toolName) {
			slog.WarnContext(ctx, "[CONTENTMCP] bearer token denied tool",
				"module", "tool", "tool", toolName,
				"auth_mode", "bearer", "uid", formatUID(actingUID(ctx, cfg)))
			return Error(fmt.Sprintf("当前 Bearer token 无权调用工具 %s", toolName)), nil
		}

		defer func() {
			if rec := recover(); rec != nil {
				slog.ErrorContext(ctx, "[CONTENTMCP] tool panicked",
					"module", "tool", "tool", toolName, "panic", rec,
					"stack", string(debug.Stack()))
				res, err = nil, fmt.Errorf("internal panic in tool %s", toolName)
			}
		}()

		res, err = h(ctx, req)
		attrs := append(safeArgs(req),
			slog.String("module", "tool"),
			slog.String("tool", toolName),
			slog.String("auth_mode", authMode(ctx)),
			slog.String("uid", formatUID(actingUID(ctx, cfg))),
			slog.Duration("elapsed", time.Since(start)))

		switch {
		case err != nil:
			attrs = append(attrs, slog.String("err", err.Error()))
			slog.LogAttrs(ctx, slog.LevelError, "[CONTENTMCP] tool handler failed", attrs...)
		case res != nil && res.IsError:
			attrs = append(attrs, slog.String("err", TruncateRunes(FirstText(res), 300)))
			slog.LogAttrs(ctx, slog.LevelWarn, "[CONTENTMCP] tool call failed", attrs...)
		default:
			slog.LogAttrs(ctx, slog.LevelInfo, "[CONTENTMCP] tool call", attrs...)
		}
		return res, err
	}
}

// actingUID resolves the uid for audit logs: service mode carries it in ctx,
// bearer mode falls back to the configured fixed uid.
func actingUID(ctx context.Context, cfg *config.Config) int64 {
	if uid, ok := identity.FromContext(ctx); ok {
		return uid
	}
	return cfg.Upstream.UID
}

func formatUID(uid int64) string {
	if uid <= 0 {
		return "-"
	}
	return fmt.Sprintf("%d", uid)
}

func authMode(ctx context.Context) string {
	switch identity.ModeFromContext(ctx) {
	case identity.ModeService:
		return "service"
	case identity.ModeBearer:
		return "bearer"
	default:
		return "stdio"
	}
}

// NotConfigured reports the tolerated-but-fatal credential/identity gap shared
// by every tool and resource handler. Service mode (per-request X-Uid) and
// bearer mode (configured fixed uid) both satisfy the identity requirement.
func NotConfigured(ctx context.Context, cfg *config.Config) string {
	if !cfg.APIKeySet() {
		return config.ErrNotConfigured.Error()
	}
	if _, ok := identity.FromContext(ctx); ok {
		return ""
	}
	if cfg.UIDSet() {
		return ""
	}
	return config.ErrNotConfigured.Error()
}
