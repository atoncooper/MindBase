package handlers

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Prompts are static, user-invoked task templates (rendered at request time,
// no upstream calls): the LLM executes them with the registered tools.

// docShape is the canonical board document shape, shared by prompt texts and
// kept in sync with the create_board/update_board tool descriptions.
const docShape = `MindMapDoc JSON 形状：{"root":{"data":{"text":"节点文本"},"children":[{"data":{"text":"子节点"},"children":[]}]},"layout":"logicalStructure","theme":{"template":"default"}}。每个节点必须有 data.text 与 children 数组（可为空）。
节点 data 可选增强字段（语义合适时使用）：note（备注文本）、tag（标签数组）、fillColor（节点底色）。
富文本卡片节点用语义字段（编辑器打开时自动转换，不要手写富文本 HTML）：代码节点 {"data":{"text":"标题","richNodeType":"code","richCode":"代码原文","richLanguage":"python"}}；Markdown 卡片 {"data":{"text":"标题","richNodeType":"md","richMarkdown":"源码"}}；概要在被概括节点 data 上加 generalizationList:[{"text":"概要文本"}]。不要生成 image 字段。`

// RegisterPrompts mounts the three guidance prompts. The prompts capability
// is advertised implicitly by AddPrompt.
func (t *Registry) RegisterPrompts(s *server.MCPServer) {
	s.AddPrompt(mcp.NewPrompt("organize_into_board",
		mcp.WithPromptDescription("把一段文本（笔记/文章/会议记录）整理成思维导图并存到 app-board。"),
		mcp.WithArgument("text", mcp.ArgumentDescription("要整理的原始文本"), mcp.RequiredArgument()),
		mcp.WithArgument("title", mcp.ArgumentDescription("板子标题；省略则从文本提炼（≤255 字符）")),
		mcp.WithArgument("kind", mcp.ArgumentDescription("类型：mindmap（默认）| whiteboard")),
	), t.organizeIntoBoardPrompt)

	s.AddPrompt(mcp.NewPrompt("review_board",
		mcp.WithPromptDescription("对一块思维导图做结构体检：找出问题并给出改进方案（不直接修改）。"),
		mcp.WithArgument("board_uuid", mcp.ArgumentDescription("板子 UUID（来自 list_boards）"), mcp.RequiredArgument()),
	), t.reviewBoardPrompt)

	s.AddPrompt(mcp.NewPrompt("board_to_outline",
		mcp.WithPromptDescription("把一块思维导图转成 markdown 大纲。"),
		mcp.WithArgument("board_uuid", mcp.ArgumentDescription("板子 UUID"), mcp.RequiredArgument()),
		mcp.WithArgument("depth", mcp.ArgumentDescription("输出层级深度（数字，省略=全部层级）")),
	), t.boardToOutlinePrompt)
}

func (t *Registry) organizeIntoBoardPrompt(_ context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	text := trimArg(req.Params.Arguments["text"])
	if text == "" {
		return nil, fmt.Errorf("缺少参数 text（要整理的原始文本）")
	}
	kind := argOr(req.Params.Arguments, "kind", "mindmap")
	if kind != "mindmap" && kind != "whiteboard" {
		return nil, fmt.Errorf("无效的 kind %q：只能是 mindmap 或 whiteboard", kind)
	}
	title := trimArg(req.Params.Arguments["title"])
	titleClause := "标题请从文本提炼（不超过 255 字符）"
	if title != "" {
		titleClause = fmt.Sprintf("标题使用：%s", title)
	}

	userText := fmt.Sprintf(`请把下面这段文本整理成思维导图并存为一块新板子。

步骤：
1. 通读文本，提炼层级结构：中心主题 1 个，一级分支按主题/章节划分，叶子放具体细节；同级节点互斥、粒度相近。
2. 调用 create_board 工具创建板子：%s，kind=%s；content 按 %s
3. 创建成功后报告：板子 uuid、标题、一级分支列表。

待整理文本：
<<<TEXT
%s
TEXT>>>`, titleClause, kind, docShape, text)
	return renderPrompt("organize_into_board", userText), nil
}

func (t *Registry) reviewBoardPrompt(_ context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	boardUUID := trimArg(req.Params.Arguments["board_uuid"])
	if boardUUID == "" {
		return nil, fmt.Errorf("缺少参数 board_uuid")
	}

	userText := fmt.Sprintf(`请对板子 %s 做结构体检。

步骤：
1. 调用 get_board 工具读取该板子（board_uuid=%s）。
2. 按以下 5 个维度逐项检查：
   - 深度失衡：个别分支明显深于其他分支
   - 同级重复：平行分支语义重叠或可合并
   - 缺失叶子：只有中间层没有具体内容的"空壳"分支
   - 节点过载：单节点文本过长（应拆分为子节点）
   - 层级过深：超过 4 层的结构
3. 输出：问题清单（每条注明节点路径）+ 一份改进后的完整 MindMapDoc JSON 方案。
4. 重要：先只给方案，不要调用 update_board；等用户明确确认后再提交。`, boardUUID, boardUUID)
	return renderPrompt("review_board", userText), nil
}

func (t *Registry) boardToOutlinePrompt(_ context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	boardUUID := trimArg(req.Params.Arguments["board_uuid"])
	if boardUUID == "" {
		return nil, fmt.Errorf("缺少参数 board_uuid")
	}
	depth := trimArg(req.Params.Arguments["depth"])
	depthClause := "输出全部层级"
	if depth != "" {
		depthClause = fmt.Sprintf("只输出前 %s 层", depth)
	}

	userText := fmt.Sprintf(`请把板子 %s 转成 markdown 大纲。

步骤：
1. 调用 get_board 工具读取该板子（board_uuid=%s）。
2. 按树形层级输出 markdown：根节点作为一级标题（#），每往下一级多用一个 #；叶子节点为列表项。%s。
3. 只输出大纲正文，不要附加解释。`, boardUUID, boardUUID, depthClause)
	return renderPrompt("board_to_outline", userText), nil
}

// renderPrompt wraps the rendered user message as a single-role prompt.
func renderPrompt(name, userText string) *mcp.GetPromptResult {
	return mcp.NewGetPromptResult(
		fmt.Sprintf("app-board-mcp %s 模板", name),
		[]mcp.PromptMessage{mcp.NewPromptMessage(mcp.RoleUser, mcp.NewTextContent(userText))},
	)
}

func argOr(args map[string]string, key, fallback string) string {
	if v, ok := args[key]; ok && v != "" {
		return v
	}
	return fallback
}

func trimArg(s string) string {
	return strings.TrimSpace(s)
}
