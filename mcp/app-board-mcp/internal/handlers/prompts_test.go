package handlers

import (
	"context"
	"strings"
	"testing"

	"app-board-mcp/internal/config"
	"app-board-mcp/internal/upstream"

	"github.com/mark3labs/mcp-go/mcp"
)

func promptReq(name string, args map[string]string) mcp.GetPromptRequest {
	return mcp.GetPromptRequest{Params: mcp.GetPromptParams{Name: name, Arguments: args}}
}

// newPromptRegistry builds a Tools whose upstream is never reached: prompt
// rendering is pure templating, the tool calls happen later on the host side.
func newPromptRegistry(t *testing.T) *Registry {
	t.Helper()
	ts := newUnconfiguredServer(t)
	cfg := &config.Config{Upstream: config.UpstreamConfig{BaseURL: ts.URL, APIKey: "k", UID: 1}}
	return New(upstream.NewClient(ts.URL, "k", 1), cfg)
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
	tool := newPromptRegistry(t)
	res, err := tool.organizeIntoBoardPrompt(context.Background(), promptReq("organize_into_board", map[string]string{
		"text":  "会议记录：讨论了 A 和 B",
		"title": "周会导图",
	}))
	text := assertUserPrompt(t, res, err)
	for _, want := range []string{"create_board", "标题使用：周会导图", "kind=mindmap", "<<<TEXT", "会议记录：讨论了 A 和 B", "MindMapDoc"} {
		if !strings.Contains(text, want) {
			t.Errorf("prompt text missing %q:\n%s", want, text)
		}
	}
}

func TestOrganizeIntoBoardPromptDefaults(t *testing.T) {
	tool := newPromptRegistry(t)
	res, err := tool.organizeIntoBoardPrompt(context.Background(), promptReq("organize_into_board", map[string]string{"text": "x"}))
	text := assertUserPrompt(t, res, err)
	if !strings.Contains(text, "kind=mindmap") || !strings.Contains(text, "标题请从文本提炼") {
		t.Errorf("defaults not applied:\n%s", text)
	}
}

func TestOrganizeIntoBoardPromptValidation(t *testing.T) {
	tool := newPromptRegistry(t)
	if _, err := tool.organizeIntoBoardPrompt(context.Background(), promptReq("organize_into_board", nil)); err == nil || !strings.Contains(err.Error(), "text") {
		t.Errorf("missing text must fail, got %v", err)
	}
	if _, err := tool.organizeIntoBoardPrompt(context.Background(), promptReq("organize_into_board", map[string]string{"text": "x", "kind": "doc"})); err == nil || !strings.Contains(err.Error(), "mindmap") {
		t.Errorf("invalid kind must fail, got %v", err)
	}
}

func TestReviewBoardPrompt(t *testing.T) {
	tool := newPromptRegistry(t)
	res, err := tool.reviewBoardPrompt(context.Background(), promptReq("review_board", map[string]string{"board_uuid": "u-9"}))
	text := assertUserPrompt(t, res, err)
	for _, want := range []string{"get_board", "u-9", "深度失衡", "不要调用 update_board", "确认"} {
		if !strings.Contains(text, want) {
			t.Errorf("prompt text missing %q:\n%s", want, text)
		}
	}
	if _, err := tool.reviewBoardPrompt(context.Background(), promptReq("review_board", nil)); err == nil || !strings.Contains(err.Error(), "board_uuid") {
		t.Errorf("missing board_uuid must fail, got %v", err)
	}
}

func TestBoardToOutlinePrompt(t *testing.T) {
	tool := newPromptRegistry(t)
	res, err := tool.boardToOutlinePrompt(context.Background(), promptReq("board_to_outline", map[string]string{"board_uuid": "u-1", "depth": "3"}))
	text := assertUserPrompt(t, res, err)
	if !strings.Contains(text, "只输出前 3 层") || !strings.Contains(text, "get_board") {
		t.Errorf("depth clause or tool guidance missing:\n%s", text)
	}

	res, err = tool.boardToOutlinePrompt(context.Background(), promptReq("board_to_outline", map[string]string{"board_uuid": "u-1"}))
	text = assertUserPrompt(t, res, err)
	if !strings.Contains(text, "输出全部层级") {
		t.Errorf("default depth clause missing:\n%s", text)
	}

	if _, err := tool.boardToOutlinePrompt(context.Background(), promptReq("board_to_outline", nil)); err == nil || !strings.Contains(err.Error(), "board_uuid") {
		t.Errorf("missing board_uuid must fail, got %v", err)
	}
}
