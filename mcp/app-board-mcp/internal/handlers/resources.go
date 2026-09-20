package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"


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

// RegisterResources mounts the board resource template and the dynamic
// resources/list hook. Capabilities: subscribe/listChanged stay off — the
// registration set never changes and app-board has no change feed.
func (t *Registry) RegisterResources(s *server.MCPServer, hooks *server.Hooks) {
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
func (t *Registry) readBoardResource(ctx context.Context, req mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return nil, fmt.Errorf("%s", msg)
	}
	boardUUID := strings.TrimPrefix(req.Params.URI, resourceURIPrefix)
	if boardUUID == "" || strings.Contains(boardUUID, "/") {
		return nil, fmt.Errorf("无效的资源 URI %q：应为 board://<uuid>", req.Params.URI)
	}

	start := time.Now()
	detail, err := t.client.Get(ctx, boardUUID)
	if err != nil {
		slog.WarnContext(ctx, "[BOARDMCP] resource read failed",
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
	slog.InfoContext(ctx, "[BOARDMCP] resource read",
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
func (t *Registry) injectListResults(ctx context.Context, _ any, _ *mcp.ListResourcesRequest, result *mcp.ListResourcesResult) {
	if t.notConfigured(ctx) != "" {
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
			slog.WarnContext(ctx, "[BOARDMCP] resource list partial",
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

	slog.InfoContext(ctx, "[BOARDMCP] resource list",
		"module", "resource", "injected", len(injected), "truncated", truncated,
		"elapsed", time.Since(start))
}
