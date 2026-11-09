// Package tools defines the MCP tool surface: a thin mapping from agent-facing
// tools onto the upstream app-board client. Business failures are reported as
// tool-level errors (CallToolResult isError) so the agent can read and react
// to them; transport/panics bubble up as handler errors.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/mcp/kit"
	boardup "app-content-mcp/internal/upstream/board"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// listScanCap bounds the search scan: at most 10 pages of 100 items.
const (
	listScanCap    = 10
	listScanAmount = 100
)

// Tools wires the upstream client into MCP tool handlers.
type BoardRegistry struct {
	client *boardup.Client
	cfg    *config.Config
}

func NewBoard(client *boardup.Client, cfg *config.Config) *BoardRegistry {
	return &BoardRegistry{client: client, cfg: cfg}
}

func (t *BoardRegistry) wrap(name string, h server.ToolHandlerFunc) server.ToolHandlerFunc {
	return kit.Wrap(name, boardSafeArgs, t.cfg, h)
}

// boardContentSchema describes the documented dual content shape: a JSON
// object OR a pre-stringified JSON string (the handler accepts both and stores
// them verbatim). mcp.WithObject would only allow object — which contradicts
// the tool description and, with WithInputSchemaValidation enabled, rejects the
// string form before the handler can run. anyOf keeps both first-class.
func boardContentSchema(description string) map[string]any {
	return map[string]any{
		"description": description,
		"anyOf": []any{
			map[string]any{"type": "object"},
			map[string]any{"type": "string"},
		},
	}
}

// Register defines all tools on the MCP server. Every handler goes through
// wrap(), which owns request-id scoping, panic recovery and the per-call log.
func (t *BoardRegistry) Register(s *server.MCPServer) {
	const contentFormat = "content 为板子文档 JSON：mindmap 用 simple-mind-map 树形结构，最小示例 " +
		`{"root":{"data":{"text":"中心主题"},"children":[{"data":{"text":"分支"},"children":[]}]}}，` +
		"可带 layout/theme 字段；whiteboard 用 Excalidraw scene JSON。content 可传 JSON 对象或 JSON 字符串，原样存储。"

	s.AddTool(mcp.NewTool("list_boards",
		mcp.WithDescription("列出当前用户的思维导图/白板（元数据，不含正文）。"),
		mcp.WithString("kind", mcp.Description("按类型过滤：mindmap（思维导图）| whiteboard（白板）；省略返回全部")),
		mcp.WithNumber("page", mcp.Description("页码，默认 1")),
		mcp.WithNumber("page_size", mcp.Description("每页数量，默认 20，上限 100")),
		mcp.WithString("search", mcp.Description("标题子串过滤（忽略大小写）；设置后自动跨页扫描（最多 1000 条），忽略 page/page_size")),
	), t.wrap("list_boards", t.listBoards))

	s.AddTool(mcp.NewTool("get_board",
		mcp.WithDescription("读取一块思维导图/白板的元数据与完整文档 JSON。返回的 version 是乐观锁版本号，更新时作为 expected_version 传回。"),
		mcp.WithString("board_uuid", mcp.Required(), mcp.Description("板子 UUID（来自 list_boards）")),
	), t.wrap("get_board", t.getBoard))

	createTool := mcp.NewTool("create_board",
		mcp.WithDescription("创建一块新的思维导图/白板。"+contentFormat),
		mcp.WithString("title", mcp.Required(), mcp.Description("标题（最长 255 字符，超长会被服务端截断）")),
		mcp.WithString("kind", mcp.Description("类型：mindmap（默认）| whiteboard")),
	)
	createTool.InputSchema.Properties["content"] = boardContentSchema("文档 JSON（可选；JSON 对象或 JSON 字符串，见工具描述中的格式说明）")
	s.AddTool(createTool, t.wrap("create_board", t.createBoard))

	updateTool := mcp.NewTool("update_board",
		mcp.WithDescription("更新思维导图/白板的标题、文档或置顶状态（至少提供一个字段）。"+contentFormat+
			"乐观锁：expected_version 传 get_board 返回的 version；省略时自动锁定当前最新版本（末写者胜）。冲突时返回最新版本号。"),
		mcp.WithString("board_uuid", mcp.Required(), mcp.Description("板子 UUID")),
		mcp.WithNumber("expected_version", mcp.Description("期望版本号（乐观锁）；省略=自动取最新版本")),
		mcp.WithString("title", mcp.Description("新标题")),
		mcp.WithBoolean("is_pinned", mcp.Description("置顶状态")),
	)
	updateTool.InputSchema.Properties["content"] = boardContentSchema("新文档 JSON（整体替换；JSON 对象或 JSON 字符串）")
	s.AddTool(updateTool, t.wrap("update_board", t.updateBoard))

	s.AddTool(mcp.NewTool("delete_board",
		mcp.WithDescription("删除一块思维导图/白板（软删除：列表与读取立即不可见，服务端 Mongo 正文保留以备人工恢复）。"),
		mcp.WithString("board_uuid", mcp.Required(), mcp.Description("板子 UUID")),
	), t.wrap("delete_board", t.deleteBoard))

	s.AddTool(mcp.NewTool("pin_board",
		mcp.WithDescription("设置思维导图/白板的置顶状态（不改变版本号）。"),
		mcp.WithString("board_uuid", mcp.Required(), mcp.Description("板子 UUID")),
		mcp.WithBoolean("is_pinned", mcp.Required(), mcp.Description("true=置顶，false=取消置顶")),
	), t.wrap("pin_board", t.pinBoard))
}

// ── logging / recovery wrapper ──────────────────────────────────────

// wrap decorates one tool handler with the cross-cutting concerns:
//
//   - request id: reused from ctx when present (HTTP middleware); generated
//     per call otherwise (stdio). The id flows into every log line here AND
//     into the upstream X-Request-Id, so one agent action is one trace.
//   - panic recovery: logged with stack, converted to a tool error result.
//   - one structured log line per call: safe args only (ids/flags/sizes,
//     never document content or titles) + outcome + duration.
//
// safeArgs extracts loggable arguments: identifiers, flags and sizes only —
// never document content (user data, up to 8MB) nor the title text itself
// (its length is enough for triage).
func boardSafeArgs(req mcp.CallToolRequest) []slog.Attr {
	args := req.GetArguments()
	attrs := make([]slog.Attr, 0, 6)
	if v, ok := args["board_uuid"].(string); ok {
		attrs = append(attrs, slog.String("board_uuid", v))
	}
	if v, ok := args["kind"].(string); ok {
		attrs = append(attrs, slog.String("kind", v))
	}
	for _, k := range []string{"page", "page_size", "expected_version", "is_pinned"} {
		if v, ok := args[k]; ok {
			attrs = append(attrs, slog.Any(k, v))
		}
	}
	if v, ok := args["search"].(string); ok {
		attrs = append(attrs, slog.String("search", kit.TruncateRunes(v, 100)))
	}
	if v, ok := args["title"].(string); ok {
		attrs = append(attrs, slog.Int("title_len", len([]rune(v))))
	}
	if token, ok := contentToken(req); ok {
		attrs = append(attrs, slog.Int("content_bytes", len(token)))
	}
	return attrs
}

// firstText returns the first text block of a tool result ("" when absent).
// ── handlers ────────────────────────────────────────────────────────

func (t *BoardRegistry) listBoards(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	kind := req.GetString("kind", "")
	if kind != "" && kind != "mindmap" && kind != "whiteboard" {
		return kit.Error(fmt.Sprintf("无效的 kind %q：只能是 mindmap 或 whiteboard", kind)), nil
	}
	search := strings.TrimSpace(req.GetString("search", ""))

	if search != "" {
		return t.listWithSearch(ctx, kind, search)
	}

	page := req.GetInt("page", 1)
	pageSize := req.GetInt("page_size", 20)
	page, pageSize = normalizePage(page, pageSize)

	list, err := t.client.List(ctx, kind, page, pageSize)
	if err != nil {
		return kit.Error(upstreamErrMsg(err)), nil
	}
	return kit.Text(mustJSON(list)), nil
}

// listWithSearch scans pages client-side and filters by title substring.
func (t *BoardRegistry) listWithSearch(ctx context.Context, kind, search string) (*mcp.CallToolResult, error) {
	needle := strings.ToLower(search)
	var (
		matched   []boardup.BoardMeta
		scanned   int64
		total     int64 = -1 // unfiltered total, from the first response
		truncated bool
	)
	for page := 1; page <= listScanCap; page++ {
		list, err := t.client.List(ctx, kind, page, listScanAmount)
		if err != nil {
			return kit.Error(upstreamErrMsg(err)), nil
		}
		if total < 0 {
			total = list.Total
		}
		for _, m := range list.Items {
			if strings.Contains(strings.ToLower(m.Title), needle) {
				matched = append(matched, m)
			}
		}
		scanned += int64(len(list.Items))
		if int64(page)*listScanAmount >= list.Total {
			break
		}
		if page == listScanCap {
			truncated = true
		}
	}
	if matched == nil {
		matched = []boardup.BoardMeta{}
	}
	out := map[string]any{
		"items":     matched,
		"matched":   len(matched),
		"total":     total,
		"scanned":   scanned,
		"truncated": truncated,
	}
	return kit.Text(mustJSON(out)), nil
}

func (t *BoardRegistry) getBoard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	boardUUID, err := req.RequireString("board_uuid")
	if err != nil {
		return kit.Error("缺少参数 board_uuid"), nil
	}
	detail, err := t.client.Get(ctx, boardUUID)
	if err != nil {
		return kit.Error(upstreamErrMsg(err)), nil
	}
	out := map[string]any{
		"uuid":      detail.UUID,
		"title":     detail.Title,
		"kind":      detail.Kind,
		"version":   detail.Version,
		"isPinned":  detail.IsPinned,
		"createdAt": detail.CreatedAt,
		"updatedAt": detail.UpdatedAt,
		"content":   parsedContent(detail.Content),
	}
	return kit.Text(mustJSON(out)), nil
}

// parsedContent turns the stored document string into a JSON object for the
// agent; unparsable/absent content passes through unchanged.
func parsedContent(content *string) any {
	if content == nil || *content == "" {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(*content), &v) != nil {
		return *content
	}
	return v
}

func (t *BoardRegistry) createBoard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	title, err := req.RequireString("title")
	if err != nil {
		return kit.Error("缺少参数 title"), nil
	}
	kind := req.GetString("kind", "mindmap")
	if kind != "mindmap" && kind != "whiteboard" {
		return kit.Error(fmt.Sprintf("无效的 kind %q：只能是 mindmap 或 whiteboard", kind)), nil
	}

	body := boardup.CreateBody{Title: title, Kind: kind}
	if content, ok := contentToken(req); ok {
		body.Content = content
	}
	meta, err := t.client.Create(ctx, body)
	if err != nil {
		return kit.Error(upstreamErrMsg(err)), nil
	}
	return kit.Text(mustJSON(meta)), nil
}

func (t *BoardRegistry) updateBoard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	boardUUID, err := req.RequireString("board_uuid")
	if err != nil {
		return kit.Error("缺少参数 board_uuid"), nil
	}

	body := boardup.UpdateBody{}
	changed := 0
	args := req.GetArguments()
	if raw, ok := args["title"]; ok {
		if s, ok := raw.(string); ok && strings.TrimSpace(s) != "" {
			title := s
			body.Title = &title
			changed++
		}
	}
	if content, ok := contentToken(req); ok {
		body.Content = content
		changed++
	}
	if _, ok := args["is_pinned"]; ok {
		pinned := req.GetBool("is_pinned", false)
		body.IsPinned = &pinned
		changed++
	}
	if changed == 0 {
		return kit.Error("至少提供 title / content / is_pinned 中的一个字段"), nil
	}

	expectedVersion := int64(req.GetInt("expected_version", 0))
	autoLocked := false
	if expectedVersion <= 0 {
		detail, err := t.client.Get(ctx, boardUUID)
		if err != nil {
			return kit.Error(upstreamErrMsg(err)), nil
		}
		expectedVersion = detail.Version
		autoLocked = true
	}

	meta, err := t.client.Update(ctx, boardUUID, expectedVersion, body)
	if err != nil {
		if boardup.ErrConflict(err) {
			return kit.Error(t.conflictMsg(ctx, boardUUID, err)), nil
		}
		return kit.Error(upstreamErrMsg(err)), nil
	}

	out := map[string]any{"board": meta}
	if autoLocked {
		out["note"] = fmt.Sprintf("未提供 expected_version：已自动锁定版本 %d 提交（末写者胜）。并发编辑场景请先 get_board 再带版本提交。", expectedVersion)
	}
	return kit.Text(mustJSON(out)), nil
}

// conflictMsg builds the 409 guidance including the current latest version.
func (t *BoardRegistry) conflictMsg(ctx context.Context, boardUUID string, err error) string {
	latest := "未知"
	if detail, gerr := t.client.Get(ctx, boardUUID); gerr == nil {
		latest = fmt.Sprintf("%d", detail.Version)
	}
	return fmt.Sprintf("版本冲突：板子已被并发修改，最新版本为 %s。请先 get_board 重新读取内容与版本，再带 expected_version 重试。（%s）", latest, upstreamErrMsg(err))
}

func (t *BoardRegistry) deleteBoard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	boardUUID, err := req.RequireString("board_uuid")
	if err != nil {
		return kit.Error("缺少参数 board_uuid"), nil
	}
	if err := t.client.Delete(ctx, boardUUID); err != nil {
		return kit.Error(upstreamErrMsg(err)), nil
	}
	return kit.Text(mustJSON(map[string]any{"deleted": true, "uuid": boardUUID})), nil
}

func (t *BoardRegistry) pinBoard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return kit.Error(msg), nil
	}
	boardUUID, err := req.RequireString("board_uuid")
	if err != nil {
		return kit.Error("缺少参数 board_uuid"), nil
	}
	isPinned, err := req.RequireBool("is_pinned")
	if err != nil {
		return kit.Error("缺少参数 is_pinned（true=置顶，false=取消）"), nil
	}
	meta, err := t.client.SetPin(ctx, boardUUID, isPinned)
	if err != nil {
		return kit.Error(upstreamErrMsg(err)), nil
	}
	return kit.Text(mustJSON(meta)), nil
}

// ── helpers ─────────────────────────────────────────────────────────

// contentToken extracts the "content" argument preserving its JSON shape:
// an object re-marshals to an object token, a string stays a string token
// (app-board accepts both and stores either verbatim).
func contentToken(req mcp.CallToolRequest) (json.RawMessage, bool) {
	raw, ok := req.GetArguments()["content"]
	if !ok || raw == nil {
		return nil, false
	}
	token, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	return token, true
}

func normalizePage(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

// notConfigured reports why board operations are unavailable, if any. Two
// valid setups: bearer clients need the configured default uid; service-mode
// callers (main-app backend) carry their per-request uid in ctx instead.
// upstreamErrMsg renders an upstream failure for the agent: readable Chinese
// prefix plus the server detail (and request_id for log correlation).
func upstreamErrMsg(err error) string {
	var apiErr *boardup.APIError
	if !errors.As(err, &apiErr) {
		return fmt.Sprintf("无法访问 app-board 网关：%v", err)
	}
	msg := fmt.Sprintf("app-board 返回 %d：%s", apiErr.Status, apiErr.Detail)
	switch apiErr.Status {
	case 413:
		msg += "（文档上限 8MB）"
	case 404:
		msg += "（板子不存在、已删除或不属于当前用户）"
	}
	if apiErr.RequestID != "" {
		msg += fmt.Sprintf(" [request_id: %s]", apiErr.RequestID)
	}
	return msg
}

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf(`{"error":"marshal tool output: %s"}`, err)
	}
	return string(data)
}
