// Package tests holds black-box tests for the consolidated MCP server.
//
// Every test lives outside the implementation packages (package tests) and
// uses only exported APIs: the tool/resource/prompt primitives are exercised
// through the official in-process MCP client (real protocol dispatch), the
// HTTP client and middlewares through their exported constructors, and the
// wrap decorator through kit.Wrap.
package tests

import (
	"context"
	"testing"

	"app-content-mcp/internal/bootstrap"
	"app-content-mcp/internal/config"

	"github.com/mark3labs/mcp-go/mcp"
)

// wantTools is the frozen tool surface inherited verbatim from app-board-mcp
// (6), app-note-mcp (4) and app-quiz-mcp (2). Agent prompt contracts depend on
// these names; any change here is a breaking protocol change.
var wantTools = []string{
	// board
	"list_boards", "get_board", "create_board", "update_board", "delete_board", "pin_board",
	// note
	"save_note", "list_notes", "get_note", "update_note",
	// quiz
	"save_quiz", "save_grading",
}

var wantPrompts = []string{"organize_into_board", "review_board", "board_to_outline"}

// TestMergedToolSurface pins the merged process surface over the MCP protocol:
// exactly the union of the three former per-domain tool surfaces (12 tools,
// unchanged names) plus the board prompts.
func TestMergedToolSurface(t *testing.T) {
	c := startInProcessClient(t, bootstrap.NewServer(&config.Config{}))
	ctx := context.Background()

	toolList, err := c.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	if len(toolList.Tools) != len(wantTools) {
		t.Fatalf("tools = %d, want %d: %v", len(toolList.Tools), len(wantTools), toolNames(toolList.Tools))
	}
	gotTools := make(map[string]bool, len(toolList.Tools))
	for _, tool := range toolList.Tools {
		gotTools[tool.Name] = true
	}
	for _, name := range wantTools {
		if !gotTools[name] {
			t.Errorf("missing tool %q (got %v)", name, toolNames(toolList.Tools))
		}
	}

	promptList, err := c.ListPrompts(ctx, mcp.ListPromptsRequest{})
	if err != nil {
		t.Fatalf("prompts/list: %v", err)
	}
	if len(promptList.Prompts) != len(wantPrompts) {
		t.Fatalf("prompts = %d, want %d: %v", len(promptList.Prompts), len(wantPrompts), promptNames(promptList.Prompts))
	}
	gotPrompts := make(map[string]bool, len(promptList.Prompts))
	for _, p := range promptList.Prompts {
		gotPrompts[p.Name] = true
	}
	for _, name := range wantPrompts {
		if !gotPrompts[name] {
			t.Errorf("missing prompt %q (got %v)", name, promptNames(promptList.Prompts))
		}
	}
}

func toolNames(tools []mcp.Tool) []string {
	out := make([]string, 0, len(tools))
	for _, tool := range tools {
		out = append(out, tool.Name)
	}
	return out
}

func promptNames(prompts []mcp.Prompt) []string {
	out := make([]string, 0, len(prompts))
	for _, p := range prompts {
		out = append(out, p.Name)
	}
	return out
}
