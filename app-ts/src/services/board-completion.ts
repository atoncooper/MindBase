import { z } from "zod";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { McpCallResult, McpToolCallOptions } from "../mcp/index.js";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";

/**
 * Board completion (AI 补全) — port of app/services/board/completion.py.
 *
 * Single structured LLM call per request (latency-sensitive, no agent loop):
 * read the board through app-board-mcp (service mode), locate the anchor node,
 * ask the model for child / sibling node suggestions, return them for the
 * editor's ghost chips. The user confirms with Tab/click; the editor applies
 * them through the normal optimistic-lock save path.
 *
 * Identity red line: the acting uid never enters the prompt or the tool
 * arguments — it rides the per-call X-Uid header (McpClient) and the gateway
 * billing header.
 */

const log = createLogger("BOARD_AI");

/** Minimal MCP surface this service needs; McpClient satisfies it structurally. */
export interface BoardMcpCaller {
  callTool(name: string, args: Record<string, unknown>, opts?: McpToolCallOptions): Promise<McpCallResult>;
}

export type BoardDirection = "children" | "siblings" | "both";

export interface BoardCompleteRequest {
  /** Board the anchor node belongs to. */
  board_uuid: string;
  /** Anchor node uid (preferred matcher). */
  anchor_uid?: string;
  /** Anchor node text (fallback matcher for documents saved before uids existed). */
  anchor_text?: string;
  /** Which suggestions to generate. */
  direction?: BoardDirection;
}

export type NodeSuggestionKind = "text" | "code" | "md";

export interface NodeSuggestion {
  /** Suggested node text (title when kind != text). */
  text: string;
  /** One-line rationale shown as the chip tooltip. */
  reason: string;
  kind: NodeSuggestionKind;
  /** Code content when kind=code. */
  code: string;
  /** Code language when kind=code. */
  language: string;
  /** Markdown source when kind=md. */
  markdown: string;
}

export interface BoardCompleteResponse {
  anchor_text: string;
  children: NodeSuggestion[];
  siblings: NodeSuggestion[];
}

/** HTTP-mapped failure carrying the Python router's status codes. */
export class BoardCompletionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BoardCompletionError";
  }
}

// Per-uid sliding-window rate limit (in-process; mirrors Python — move to Redis counters when workers scale out).
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

// Bound the prompt: only the anchor neighbourhood goes to the model.
const MAX_SIBLING_NAMES = 12;
const MAX_TEXT_CHARS = 60;
const MAX_DOC_CHARS = 3000;

/** Structured-output schema for the completion LLM call (mirrors Python _SuggestionSchema). */
export const nodeIdeaSchema = z.object({
  text: z.string(),
  reason: z.string().default(""),
  kind: z.string().default("text"),
  code: z.string().default(""),
  language: z.string().default(""),
  markdown: z.string().default(""),
});

export const suggestionSchema = z.object({
  children: z.array(nodeIdeaSchema).default([]),
  siblings: z.array(nodeIdeaSchema).default([]),
});

export type NodeIdea = z.infer<typeof nodeIdeaSchema>;

/** Injectable structured-output call (tests supply a stub; default = AI SDK generateObject). */
export type BoardCompletionGenerator = (args: {
  model: LanguageModel;
  schema: typeof suggestionSchema;
  prompt: string;
  temperature: number;
  maxRetries: number;
}) => Promise<{ object: unknown }>;

const defaultGenerator: BoardCompletionGenerator = async (args) => {
  const { object } = await generateObject({
    model: args.model,
    schema: args.schema,
    prompt: args.prompt,
    temperature: args.temperature,
    maxRetries: args.maxRetries,
  });
  return { object };
};

export interface BoardCompletionOptions {
  client: BoardMcpCaller;
  /** injectable for tests; default = gateway model with purpose="board_complete" */
  model?: LanguageModel;
  /** optional model override (config boardMcp.completionModel); empty = config.llm.model */
  completionModel?: string;
  /** injectable for tests; default = generateObject */
  generate?: BoardCompletionGenerator;
}

export class BoardCompletionService {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: BoardCompletionOptions) {}

  /** Generate child/sibling suggestions for the anchor node. */
  async complete(uid: string, req: BoardCompleteRequest): Promise<BoardCompleteResponse> {
    if (this.rateLimited(uid)) {
      throw new BoardCompletionError("补全请求过于频繁，请稍后再试", 429);
    }

    const board = await this.getBoard(uid, req.board_uuid);
    const doc = parseBoardDoc(board.content);
    const root = doc.root;
    if (!isPlainObject(root)) {
      // empty / unparseable board: nothing to anchor on
      return { anchor_text: "", children: [], siblings: [] };
    }

    const anchor = findAnchor(root, req.anchor_uid ?? "", req.anchor_text ?? "");
    if (!anchor) {
      throw new BoardCompletionError("未找到锚点节点：请刷新板子后重试", 404);
    }
    const anchorData = isPlainObject(anchor.data) ? anchor.data : {};
    const anchorText = shortText(anchorData.text);

    const parent = findParent(root, anchor);
    const parentChildren = parent && Array.isArray(parent.children) ? parent.children : [];
    const siblingNames = parentChildren
      .filter((child): child is Record<string, unknown> => isPlainObject(child) && child !== anchor)
      .map((child) => shortText(isPlainObject(child.data) ? child.data.text : ""))
      .filter((name) => name.length > 0)
      .slice(0, MAX_SIBLING_NAMES);

    const direction: BoardDirection = req.direction ?? "both";
    const docJson = JSON.stringify(doc).slice(0, MAX_DOC_CHARS);
    const prompt = buildPrompt(shortText(board.title), docJson, anchorText, siblingNames, direction);

    const model =
      this.opts.model ??
      createGatewayModel("board_complete", {
        uid,
        temperature: 0.7,
        model: this.opts.completionModel || undefined,
      });
    const generate = this.opts.generate ?? defaultGenerator;
    const { object } = await generate({ model, schema: suggestionSchema, prompt, temperature: 0.7, maxRetries: 2 });
    const parsed = suggestionSchema.parse(object);

    const response: BoardCompleteResponse = {
      anchor_text: anchorText,
      children: normalizeSuggestions(direction !== "siblings" ? parsed.children : []),
      siblings: normalizeSuggestions(direction !== "children" ? parsed.siblings : []),
    };
    log.info(
      "[BOARD_AI] complete uid=" + uid + " board=" + req.board_uuid +
        " children=" + response.children.length + " siblings=" + response.siblings.length,
    );
    return response;
  }

  /** One MCP read; transport and tool failures both map to 502 (Python BoardMCPError → 502). */
  private async getBoard(uid: string, boardUuid: string): Promise<Record<string, unknown>> {
    const result = await this.opts.client.callTool("get_board", { board_uuid: boardUuid }, { uid });
    if (!result.ok) {
      throw new BoardCompletionError("board 服务暂不可达（get_board）: " + (result.error ?? "未知错误"), 502);
    }
    try {
      const parsed: unknown = JSON.parse(result.content);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private rateLimited(uid: string, now = Date.now()): boolean {
    const cutoff = now - RATE_WINDOW_MS;
    const recent = (this.hits.get(uid) ?? []).filter((t) => t > cutoff);
    if (recent.length >= RATE_LIMIT) {
      this.hits.set(uid, recent);
      return true;
    }
    recent.push(now);
    this.hits.set(uid, recent);
    return false;
  }
}

// ---------- pure helpers (ported; exported for tests) ----------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Board content arrives as a JSON string (app-board stores it verbatim). */
export function parseBoardDoc(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    try {
      const doc: unknown = JSON.parse(content);
      return isPlainObject(doc) ? doc : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(content) ? content : {};
}

export function shortText(text: unknown): string {
  return String(text ?? "").trim().slice(0, MAX_TEXT_CHARS);
}

export function findAnchor(
  node: Record<string, unknown>,
  uid: string,
  text: string,
): Record<string, unknown> | null {
  const data = isPlainObject(node.data) ? node.data : {};
  if (uid && data.uid === uid) return node;
  if (!uid && text && data.text === text) return node;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!isPlainObject(child)) continue;
    const found = findAnchor(child, uid, text);
    if (found) return found;
  }
  return null;
}

/** Walk the tree to find the parent object of target (identity match). */
export function findParent(
  root: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown> | null {
  const stack: Array<Record<string, unknown>> = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (!isPlainObject(child)) continue;
      if (child === target) return node;
      stack.push(child);
    }
  }
  return null;
}

export function buildPrompt(
  boardTitle: string,
  docJson: string,
  anchorText: string,
  siblingNames: string[],
  direction: BoardDirection,
): string {
  const siblings = siblingNames.length > 0 ? siblingNames.join("、") : "（无）";
  const directionLine =
    direction === "children"
      ? "只给出 children 建议，siblings 留空数组。"
      : direction === "siblings"
        ? "只给出 siblings 建议，children 留空数组。"
        : "children 与 siblings 都要给出。";
  return (
    "你在为一张思维导图做节点补全。下面是导图的文档 JSON 与锚点节点信息。\n" +
    "请推荐与锚点语义相关的新节点：children 是挂在锚点下的子节点；" +
    "siblings 是与锚点同级的节点（挂在同一个父节点下）。\n" +
    "要求：不要重复已有节点；每个建议是一句简洁的节点文本（不超过 30 字）；" +
    "只依据导图主题与锚点语义，不要编造导图中不存在的上下文。\n" +
    "节点类型（kind）：\n" +
    '- 默认 kind="text"，只填 text（简洁标题）。\n' +
    '- 当内容确实是一段完整代码（函数/算法/命令）时用 kind="code"，填 code（完整代码）与 language（语言标识如 python/js），text 填一句话标题；仅当代码是节点核心内容（算法实现/命令示例）才用，普通概念节点不用。\n' +
    '- 当内容是成段的 Markdown 文本（笔记/引用/表格/列表）时用 kind="md"，填 markdown（Markdown 源码），text 填一句话标题。\n' +
    directionLine + "\n\n" +
    "导图标题：" + boardTitle + "\n" +
    "锚点节点文本：" + anchorText + "\n" +
    "锚点的同级节点（已存在，禁止重复）：" + siblings + "\n" +
    "导图文档 JSON（可能被截断）：\n" + docJson + "\n"
  );
}

/** Normalize model output: validate kind, downgrade malformed code/md to text. */
export function normalizeSuggestions(items: NodeIdea[] | undefined | null): NodeSuggestion[] {
  const out: NodeSuggestion[] = [];
  for (const item of items ?? []) {
    const text = shortText(item.text);
    if (!text) continue;
    const reason = shortText(item.reason);
    const kind: NodeSuggestionKind = item.kind === "code" || item.kind === "md" ? item.kind : "text";
    if (kind === "code" && item.code.trim()) {
      out.push({ text, reason, kind: "code", code: item.code.trim(), language: shortText(item.language) || "text", markdown: "" });
    } else if (kind === "md" && item.markdown.trim()) {
      out.push({ text, reason, kind: "md", code: "", language: "", markdown: item.markdown.trim() });
    } else {
      out.push({ text, reason, kind: "text", code: "", language: "", markdown: "" });
    }
  }
  return out;
}
