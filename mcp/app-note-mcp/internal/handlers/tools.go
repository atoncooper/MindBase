// Package handlers defines the MCP tool surface: a thin mapping from
// agent-facing tools onto the upstream app-note client. Business failures are
// reported as tool-level errors (CallToolResult isError) so the agent can
// read and react to them; transport/panics bubble up as handler errors.
//
// Tool surface (4): save_note / list_notes / get_note / update_note — same
// names and parameters as the former in-process Python tools, so the note
// agent's prompt contract is unchanged. No delete tool: the agent must not
// remove user notes.
package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"time"

	"app-note-mcp/internal/config"
	"app-note-mcp/internal/identity"
	"app-note-mcp/internal/logger"
	"app-note-mcp/internal/upstream"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Tools wires the upstream client into MCP tool handlers.
type Registry struct {
	client *upstream.Client
	cfg    *config.Config
}

func New(client *upstream.Client, cfg *config.Config) *Registry {
	return &Registry{client: client, cfg: cfg}
}

// Register defines all tools on the MCP server. Every handler goes through
// wrap(), which owns request-id scoping, panic recovery and the per-call log.
func (t *Registry) Register(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("save_note",
		mcp.WithDescription("保存一篇 Markdown 笔记到用户的笔记库。调用后笔记即持久化，无需再输出笔记正文。"),
		mcp.WithString("title", mcp.Required(), mcp.Description("笔记标题（最长 500 字符）")),
		mcp.WithString("target_type", mcp.Required(),
			mcp.Description("笔记关联的对象类型：video（视频笔记）| cloud_file（云盘文档笔记）")),
		mcp.WithString("target_id", mcp.Required(),
			mcp.Description("关联对象 ID。video 用 bvid:cid（如 BV1xx:123）；cloud_file 用文档 id")),
		mcp.WithString("content_md", mcp.Required(),
			mcp.Description("笔记正文，必须是 Markdown 格式（≤256KB；原始 HTML 与危险 URL 会被服务端消毒）")),
	), t.wrap("save_note", t.saveNote))

	s.AddTool(mcp.NewTool("list_notes",
		mcp.WithDescription("列出用户的笔记（仅元数据：标题/uuid/目标/更新时间，不含正文）。用于查看用户有哪些笔记、找到要分析或修改的笔记。"),
		mcp.WithString("target_type", mcp.Description("按关联类型过滤：video | cloud_file；省略返回全部")),
	), t.wrap("list_notes", t.listNotes))

	s.AddTool(mcp.NewTool("get_note",
		mcp.WithDescription("获取指定笔记的完整正文（Markdown）。用于分析笔记内容、查看笔记详情后再决定如何修改。需要 note_uuid（可从 list_notes 获取）。"),
		mcp.WithString("note_uuid", mcp.Required(), mcp.Description("笔记的 UUID（来自 list_notes）")),
	), t.wrap("get_note", t.getNote))

	s.AddTool(mcp.NewTool("update_note",
		mcp.WithDescription("修改已有笔记的正文或标题。content_md 必须是完整的 Markdown 正文（会替换原有正文，不是追加）。修改前建议先用 get_note 查看原内容。"),
		mcp.WithString("note_uuid", mcp.Required(), mcp.Description("笔记 UUID")),
		mcp.WithString("content_md", mcp.Required(), mcp.Description("新的 Markdown 正文（完整内容，非追加）")),
		mcp.WithString("title", mcp.Description("新标题（可选，不传则不改标题）")),
	), t.wrap("update_note", t.updateNote))
}

// ── logging / recovery wrapper ──────────────────────────────────────

// wrap decorates one tool handler with the cross-cutting concerns:
//
//   - request id: reused from ctx when present (HTTP middleware); generated
//     per call otherwise (stdio). The id flows into every log line here AND
//     into the upstream X-Request-Id, so one agent action is one trace.
//   - panic recovery: logged with stack, converted to a tool error result.
//   - one structured log line per call: safe args only (ids/flags/sizes,
//     never note content or titles) + outcome + duration.
func (t *Registry) wrap(name string, h server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (res *mcp.CallToolResult, err error) {
		start := time.Now()
		if logger.FromContext(ctx) == logger.DefaultRequestID {
			ctx = logger.IntoContext(ctx, uuid.NewString())
		}

		defer func() {
			if rec := recover(); rec != nil {
				slog.ErrorContext(ctx, "[NOTEMCP] tool panicked",
					"module", "tool", "tool", name, "panic", rec,
					"stack", string(debug.Stack()))
				res, err = nil, fmt.Errorf("internal panic in tool %s", name)
			}
		}()

		res, err = h(ctx, req)
		attrs := append(safeArgs(req),
			slog.String("module", "tool"),
			slog.String("tool", name),
			slog.Duration("elapsed", time.Since(start)))

		switch {
		case err != nil:
			attrs = append(attrs, slog.String("err", err.Error()))
			slog.LogAttrs(ctx, slog.LevelError, "[NOTEMCP] tool handler failed", attrs...)
		case res != nil && res.IsError:
			attrs = append(attrs, slog.String("err", truncateRunes(firstText(res), 300)))
			slog.LogAttrs(ctx, slog.LevelWarn, "[NOTEMCP] tool call failed", attrs...)
		default:
			slog.LogAttrs(ctx, slog.LevelInfo, "[NOTEMCP] tool call", attrs...)
		}
		return res, err
	}
}

// safeArgs extracts loggable arguments: identifiers, flags and sizes only —
// never the note content (user data) nor the title text itself.
func safeArgs(req mcp.CallToolRequest) []slog.Attr {
	args := req.GetArguments()
	attrs := make([]slog.Attr, 0, 6)
	if v, ok := args["note_uuid"].(string); ok {
		attrs = append(attrs, slog.String("note_uuid", v))
	}
	if v, ok := args["target_type"].(string); ok {
		attrs = append(attrs, slog.String("target_type", v))
	}
	if v, ok := args["target_id"].(string); ok {
		attrs = append(attrs, slog.String("target_id", v))
	}
	if v, ok := args["title"].(string); ok {
		attrs = append(attrs, slog.Int("title_len", len([]rune(v))))
	}
	for _, k := range []string{"content_md"} {
		if v, ok := args[k].(string); ok {
			attrs = append(attrs, slog.Int(k+"_bytes", len(v)))
		}
	}
	return attrs
}

// firstText returns the first text block of a tool result ("" when absent).
func firstText(res *mcp.CallToolResult) string {
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

func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// ── handlers ────────────────────────────────────────────────────────

func (t *Registry) notConfigured(ctx context.Context) string {
	if !t.cfg.APIKeySet() {
		return "笔记服务未配置上游凭证（NOTEMCP__UPSTREAM__API_KEY），无法执行操作"
	}
	if _, ok := identity.FromContext(ctx); !ok && !t.cfg.UIDSet() {
		return "笔记服务未配置用户身份（NOTEMCP__UPSTREAM__UID 或服务模式 X-Uid），无法执行操作"
	}
	return ""
}

func (t *Registry) saveNote(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	title := strings.TrimSpace(req.GetString("title", ""))
	targetType := strings.TrimSpace(req.GetString("target_type", ""))
	targetID := strings.TrimSpace(req.GetString("target_id", ""))
	contentMD := req.GetString("content_md", "")

	if title == "" {
		return errorResult("缺少 title：请提供笔记标题"), nil
	}
	if len([]rune(title)) > 500 {
		return errorResult("标题过长（上限 500 字符）"), nil
	}
	if targetType != "video" && targetType != "cloud_file" {
		return errorResult(fmt.Sprintf("无效的 target_type %q：只能是 video 或 cloud_file", targetType)), nil
	}
	if targetID == "" || len(targetID) > 100 {
		return errorResult("target_id 必填且不超过 100 字符"), nil
	}
	if contentMD == "" {
		return errorResult("缺少 content_md：请提供完整的 Markdown 正文"), nil
	}

	detail, err := t.client.Create(ctx, upstream.CreateBody{
		Title:      title,
		TargetType: targetType,
		TargetID:   targetID,
		ContentMD:  contentMD,
	})
	if err != nil {
		return errorResult(upstreamErr("保存失败", err)), nil
	}
	return textResult(fmt.Sprintf("已保存笔记《%s》（uuid=%s）", detail.Title, detail.UUID)), nil
}

func (t *Registry) listNotes(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	targetType := strings.TrimSpace(req.GetString("target_type", ""))
	if targetType != "" && targetType != "video" && targetType != "cloud_file" {
		return errorResult(fmt.Sprintf("无效的 target_type %q：只能是 video 或 cloud_file", targetType)), nil
	}

	notes, total, err := t.client.List(ctx, targetType, 1, 50)
	if err != nil {
		return errorResult(upstreamErr("查询失败", err)), nil
	}
	if len(notes) == 0 {
		return textResult("暂无笔记。"), nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "共 %d 篇笔记：", total)
	for _, n := range notes {
		fmt.Fprintf(&b, "\n- 《%s》uuid=%s target=%s:%s updated=%s",
			n.Title, n.UUID, n.TargetType, n.TargetID, n.UpdatedAt)
	}
	return textResult(b.String()), nil
}

func (t *Registry) getNote(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	noteUUID := strings.TrimSpace(req.GetString("note_uuid", ""))
	if noteUUID == "" {
		return errorResult("缺少 note_uuid：请从 list_notes 的结果中获取"), nil
	}

	detail, err := t.client.Get(ctx, noteUUID)
	if err != nil {
		return errorResult(upstreamErr("获取失败", err)), nil
	}
	return textResult(fmt.Sprintf("笔记《%s》正文：\n\n%s", detail.Title, detail.ContentMD)), nil
}

func (t *Registry) updateNote(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	noteUUID := strings.TrimSpace(req.GetString("note_uuid", ""))
	contentMD := req.GetString("content_md", "")
	title := req.GetString("title", "")

	if noteUUID == "" {
		return errorResult("缺少 note_uuid：请从 list_notes 的结果中获取"), nil
	}
	if contentMD == "" {
		return errorResult("缺少 content_md：请提供完整的 Markdown 正文（整体替换，非追加）"), nil
	}
	body := upstream.UpdateBody{ContentMD: &contentMD}
	if strings.TrimSpace(title) != "" {
		if len([]rune(title)) > 500 {
			return errorResult("标题过长（上限 500 字符）"), nil
		}
		body.Title = &title
	}

	detail, err := t.client.Update(ctx, noteUUID, body)
	if err != nil {
		return errorResult(upstreamErr("修改失败", err)), nil
	}
	return textResult(fmt.Sprintf("已修改笔记《%s》（uuid=%s）", detail.Title, detail.UUID)), nil
}

// upstreamErr renders an upstream failure for the agent: app-note's own
// detail (e.g. "笔记不存在") is passed through; other failures keep the
// operation verb. 404 keeps the cross-user/no-existence-leak semantics.
func upstreamErr(verb string, err error) string {
	var apiErr *upstream.APIError
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.Status == 404:
			return verb + "：笔记不存在或不可访问"
		case apiErr.Status == 401 || apiErr.Status == 403:
			return verb + "：服务鉴权失败，请检查网关凭证配置"
		case apiErr.Status >= 500:
			return verb + "：笔记服务暂不可用，请稍后重试"
		default:
			if apiErr.Detail != "" {
				return fmt.Sprintf("%s：%s", verb, apiErr.Detail)
			}
		}
	}
	return fmt.Sprintf("%s：%v", verb, err)
}

func errorResult(msg string) *mcp.CallToolResult {
	return mcp.NewToolResultError(msg)
}

func textResult(msg string) *mcp.CallToolResult {
	return mcp.NewToolResultText(msg)
}
