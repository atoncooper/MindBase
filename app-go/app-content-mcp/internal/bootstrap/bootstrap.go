// Package bootstrap owns the app-content-mcp composition root: one MCP server
// exposing the board, note and quiz tool surfaces (12 tools total, names
// unchanged from the three former per-domain MCP servers) plus the board
// resources/prompts.
//
// The MCP primitive packages are the organizing unit:
//
//	mcp/tools     12 tools (board 6 + note 4 + quiz 2)
//	mcp/resources board://{uuid} template + request-time resources/list
//	mcp/prompts   3 board prompts
//
// Domain code never crosses primitives except through this file (the only
// place that knows all three), and upstream/{board,note,quiz} stay separate.
package bootstrap

import (
	"context"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/identity"
	"app-content-mcp/internal/mcp/prompts"
	"app-content-mcp/internal/mcp/resources"
	"app-content-mcp/internal/mcp/tools"
	boardup "app-content-mcp/internal/upstream/board"
	noteup "app-content-mcp/internal/upstream/note"
	quizup "app-content-mcp/internal/upstream/quiz"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Server name/version reported in the MCP initialize handshake.
const (
	ServerName    = "app-content-mcp"
	ServerVersion = "0.1.0"
)

// NewServer builds the single MCP server with all content-domain tools,
// resources and prompts registered. Registration only wires handlers; no
// upstream call is made until a tool is invoked.
func NewServer(cfg *config.Config) *server.MCPServer {
	// One upstream client per domain: same gateway base + consumer key, and
	// each call still carries the acting uid (service mode per request,
	// bearer mode from config).
	boardClient := boardup.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID)
	noteClient := noteup.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID)
	quizClient := quizup.NewClient(cfg.Upstream.BaseURL, cfg.Upstream.APIKey, cfg.Upstream.UID)

	// Hooks carry the dynamic resources/list injection (request-time upstream
	// fan-out); the registration set itself never changes at runtime.
	hooks := &server.Hooks{}

	// Least privilege for external hosts: when a bearer token is pinned to a
	// tool subset, hide the rest from tools/list too (calling one is rejected
	// by kit.Wrap). Service mode keeps the full surface.
	hooks.AddAfterListTools(func(ctx context.Context, _ any, _ *mcp.ListToolsRequest, result *mcp.ListToolsResult) {
		if identity.ModeFromContext(ctx) != identity.ModeBearer || len(cfg.Server.BearerAllowedTools) == 0 {
			return
		}
		kept := result.Tools[:0]
		for _, tool := range result.Tools {
			if cfg.BearerToolAllowed(tool.Name) {
				kept = append(kept, tool)
			}
		}
		result.Tools = kept
	})
	mcpServer := server.NewMCPServer(
		ServerName,
		ServerVersion,
		server.WithRecovery(),
		// Validate tool arguments against each tool's declared inputSchema
		// before the handler runs (mcp-go is opt-in). Failures come back as a
		// tool error result the model can self-correct from.
		server.WithInputSchemaValidation(),
		// subscribe off (no change feed from app-content); listChanged off
		// (static registration set, the list is refreshed per-request via hooks).
		server.WithResourceCapabilities(false, false),
		server.WithHooks(hooks),
	)

	// MCP primitive registration, in the spec's order: tools, resources, prompts.
	tools.NewBoard(boardClient, cfg).Register(mcpServer)
	tools.NewNote(noteClient, cfg).Register(mcpServer)
	tools.NewQuiz(quizClient, cfg).Register(mcpServer)

	resources.NewBoard(boardClient, cfg).RegisterResources(mcpServer, hooks)
	prompts.NewBoard().RegisterPrompts(mcpServer)

	return mcpServer
}
