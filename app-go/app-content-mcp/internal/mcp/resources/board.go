package resources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-content-mcp/internal/config"
	"app-content-mcp/internal/mcp/kit"
	boardup "app-content-mcp/internal/upstream/board"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Resource URI scheme: board://{uuid} -> one board document (metadata +
// parsed editor JSON). The list hook injects live instances into
// resources/list at request time (no polling, no stale snapshot).
const (
	resourceURIPrefix  = "board://"
	resourceMIMEType   = "application/json"
	listEnumeratePages = 10 // 10 pages x 100 = 1000 boards max per resources/list
	listEnumerateSize  = 100
)

// Board wires the board upstream client into the resources primitive. It is
// the resources-side counterpart of tools.BoardRegistry (same client + config,
// separate type so the MCP primitive surface is explicit).
type Board struct {
	client *boardup.Client
	cfg    *config.Config
}

// NewBoard builds the board resource handlers.
func NewBoard(client *boardup.Client, cfg *config.Config) *Board {
	return &Board{client: client, cfg: cfg}
}

// RegisterResources mounts the board resource template and the dynamic
// resources/list hook. Capabilities: subscribe/listChanged stay off — the
// registration set never changes and app-board has no change feed.
func (t *Board) RegisterResources(s *server.MCPServer, hooks *server.Hooks) {
	tpl := mcp.NewResourceTemplate(
		resourceURIPrefix+"{uuid}",
		"思维导图/白板文档",
		mcp.WithTemplateDescription("读取一块思维导图/白板的完整文档（元数据 + 编辑器 JSON）。URI 形如 board://<uuid>，uuid 来自 resources/list 或 list_boards 工具。"),
		mcp.WithTemplateMIMEType(resourceMIMEType),
	)
	s.AddResourceTemplate(tpl, t.readBoardResource)

	hooks.AddAfterListResources(t.injectListResults)
}

// readBoardResource serves resources/read board://<uuid>: live upstream Get,
// wrapped so the host also sees the optimistic-lock version.
func (t *Board) readBoardResource(ctx context.Context, req mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
	if msg := kit.NotConfigured(ctx, t.cfg); msg != "" {
		return nil, fmt.Errorf("%s", msg)
	}
	boardUUID := strings.TrimPrefix(req.Params.URI, resourceURIPrefix)
	if boardUUID == "" || strings.Contains(boardUUID, "/") {
		return nil, fmt.Errorf("无效的资源 URI %q：应为 board://<uuid>", req.Params.URI)
	}

	start := time.Now()
	detail, err := t.client.Get(ctx, boardUUID)
	if err != nil {
		slog.WarnContext(ctx, "[CONTENTMCP] resource read failed",
			"module", "resource", "board_uuid", boardUUID, "err", upstreamErrMsg(err))
		return nil, fmt.Errorf("%s", upstreamErrMsg(err))
	}

	payload := map[string]any{
		"uuid":      detail.UUID,
		"title":     detail.Title,
		"kind":      detail.Kind,
		"version":   detail.Version,
		"isPinned":  detail.IsPinned,
		"createdAt": detail.CreatedAt,
		"updatedAt": detail.UpdatedAt,
		"content":   parsedContent(detail.Content),
	}
	slog.InfoContext(ctx, "[CONTENTMCP] resource read",
		"module", "resource", "board_uuid", boardUUID,
		"kind", detail.Kind, "version", detail.Version,
		"elapsed", time.Since(start))

	return []mcp.ResourceContents{mcp.TextResourceContents{
		URI:      req.Params.URI,
		MIMEType: resourceMIMEType,
		Text:     mustJSON(payload),
	}}, nil
}

// injectListResults refreshes resources/list with the current boards: pages
// the upstream list (best-effort, capped) and appends live resource entries
// to the result. Runs after the server's (empty) static list.
func (t *Board) injectListResults(ctx context.Context, _ any, _ *mcp.ListResourcesRequest, result *mcp.ListResourcesResult) {
	if kit.NotConfigured(ctx, t.cfg) != "" {
		return
	}

	start := time.Now()
	var injected []mcp.Resource
	truncated := false
	for page := 1; page <= listEnumeratePages; page++ {
		list, err := t.client.List(ctx, "", page, listEnumerateSize)
		if err != nil {
			// Best effort: keep whatever was injected; the host still gets
			// resources (or an empty list) instead of a failed request.
			slog.WarnContext(ctx, "[CONTENTMCP] resource list partial",
				"module", "resource", "page", page, "err", upstreamErrMsg(err))
			break
		}
		for _, meta := range list.Items {
			injected = append(injected, mcp.NewResource(
				resourceURIPrefix+meta.UUID,
				meta.Title,
				mcp.WithResourceDescription(fmt.Sprintf("%s · 更新于 %s · version %d", meta.Kind, meta.UpdatedAt.Format("2006-01-02 15:04"), meta.Version)),
				mcp.WithMIMEType(resourceMIMEType),
			))
		}
		if int64(page)*listEnumerateSize >= list.Total {
			break
		}
		if page == listEnumeratePages {
			truncated = true
		}
	}

	if truncated && len(injected) > 0 {
		last := injected[len(injected)-1]
		last.Description = strings.TrimSpace(last.Description + " ·（列表已截断至上限 1000，更多请用 list_boards 工具查询）")
		injected[len(injected)-1] = last
	}
	result.Resources = append(result.Resources, injected...)

	slog.InfoContext(ctx, "[CONTENTMCP] resource list",
		"module", "resource", "injected", len(injected), "truncated", truncated,
		"elapsed", time.Since(start))
}

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

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf(`{"error":"marshal tool output: %s"}`, err)
	}
	return string(data)
}
