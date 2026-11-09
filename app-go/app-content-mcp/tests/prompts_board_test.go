package tests

import (
	"context"
	"strings"
	"testing"

	"app-content-mcp/internal/mcp/prompts"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// newPromptClient mounts the board prompts primitive and connects the
// official in-process client: rendering is pure templating (no upstream), the
// tool calls happen later on the host side.
func newPromptClient(t *testing.T) *mcpclient.Client {
	t.Helper()
	srv := server.NewMCPServer("app-content-mcp-tests", "0.0.0",
		server.WithRecovery(),
		server.WithPromptCapabilities(true),
	)
	prompts.NewBoard().RegisterPrompts(srv)
	return startInProcessClient(t, srv)
}

func getPrompt(t *testing.T, c *mcpclient.Client, name string, args map[string]string) (*mcp.GetPromptResult, error) {
	t.Helper()
	return c.GetPrompt(context.Background(), mcp.GetPromptRequest{
		Params: mcp.GetPromptParams{Name: name, Arguments: args},
	})
}

// assertUserPrompt checks the rendered result shape and returns the text.
func assertUserPrompt(t *testing.T, res *mcp.GetPromptResult, err error) string {
	t.Helper()
	if err != nil {
		t.Fatalf("render error: %v", err)
	}
	if len(res.Messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(res.Messages))
	}
	msg := res.Messages[0]
	if msg.Role != mcp.RoleUser {
		t.Errorf("role = %q, want user", msg.Role)
	}
	text, ok := msg.Content.(mcp.TextContent)
	if !ok {
		t.Fatalf("want TextContent, got %T", msg.Content)
	}
	return text.Text
}

func TestOrganizeIntoBoardPrompt(t *testing.T) {
	c := newPromptClient(t)
	res, err := getPrompt(t, c, "organize_into_board", map[string]string{
		"text":  "会议记录：讨论了 A 和 B",
		"title": "周会导图",
	})
	text := assertUserPrompt(t, res, err)
	for _, want := range []string{"create_board", "标题使用：周会导图", "kind=mindmap", "<<<TEXT", "会议记录：讨论了 A 和 B", "MindMapDoc"} {
		if !strings.Contains(text, want) {
			t.Errorf("prompt text missing %q:\n%s", want, text)
		}
	}
}

func TestOrganizeIntoBoardPromptDefaults(t *testing.T) {
	c := newPromptClient(t)
	res, err := getPrompt(t, c, "organize_into_board", map[string]string{"text": "x"})
	text := assertUserPrompt(t, res, err)
	if !strings.Contains(text, "kind=mindmap") || !strings.Contains(text, "标题请从文本提炼") {
		t.Errorf("defaults not applied:\n%s", text)
	}
}

func TestOrganizeIntoBoardPromptValidation(t *testing.T) {
	c := newPromptClient(t)
	if _, err := getPrompt(t, c, "organize_into_board", nil); err == nil || !strings.Contains(err.Error(), "text") {
		t.Errorf("missing text must fail, got %v", err)
	}
	if _, err := getPrompt(t, c, "organize_into_board", map[string]string{"text": "x", "kind": "doc"}); err == nil || !strings.Contains(err.Error(), "mindmap") {
		t.Errorf("invalid kind must fail, got %v", err)
	}
}

func TestReviewBoardPrompt(t *testing.T) {
	c := newPromptClient(t)
	res, err := getPrompt(t, c, "review_board", map[string]string{"board_uuid": "u-9"})
	text := assertUserPrompt(t, res, err)
	for _, want := range []string{"get_board", "u-9", "深度失衡", "不要调用 update_board", "确认"} {
		if !strings.Contains(text, want) {
			t.Errorf("prompt text missing %q:\n%s", want, text)
		}
	}
	if _, err := getPrompt(t, c, "review_board", nil); err == nil || !strings.Contains(err.Error(), "board_uuid") {
		t.Errorf("missing board_uuid must fail, got %v", err)
	}
}

func TestBoardToOutlinePrompt(t *testing.T) {
	c := newPromptClient(t)
	res, err := getPrompt(t, c, "board_to_outline", map[string]string{"board_uuid": "u-1", "depth": "3"})
	text := assertUserPrompt(t, res, err)
	if !strings.Contains(text, "只输出前 3 层") || !strings.Contains(text, "get_board") {
		t.Errorf("depth clause or tool guidance missing:\n%s", text)
	}

	res, err = getPrompt(t, c, "board_to_outline", map[string]string{"board_uuid": "u-1"})
	text = assertUserPrompt(t, res, err)
	if !strings.Contains(text, "输出全部层级") {
		t.Errorf("default depth clause missing:\n%s", text)
	}

	if _, err := getPrompt(t, c, "board_to_outline", nil); err == nil || !strings.Contains(err.Error(), "board_uuid") {
		t.Errorf("missing board_uuid must fail, got %v", err)
	}
}

// TestListBoardPrompts pins the prompts/list surface and descriptions.
func TestListBoardPrompts(t *testing.T) {
	c := newPromptClient(t)
	result, err := c.ListPrompts(context.Background(), mcp.ListPromptsRequest{})
	if err != nil {
		t.Fatalf("list prompts: %v", err)
	}
	got := make(map[string]bool, len(result.Prompts))
	for _, p := range result.Prompts {
		got[p.Name] = true
		if p.Description == "" {
			t.Errorf("prompt %q has no description", p.Name)
		}
	}
	for _, name := range wantPrompts {
		if !got[name] {
			t.Errorf("missing prompt %q (got %v)", name, got)
		}
	}
}
