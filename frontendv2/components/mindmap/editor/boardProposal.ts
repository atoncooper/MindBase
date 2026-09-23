/**
 * 板聊「建议节点」解析：assistant 回复中的 ```board-nodes 围栏块是 board
 * agent 给出的结构化新增节点建议（anchor_text + children/siblings）。解析成
 * 卡片数据后由 BoardChatPanel 渲染「插入画布」动作；MindMapEditorView 把建议
 * 转成幽灵节点（Tab 确认 / Esc 丢弃），复用编辑器补全的同一套插入机制。
 */
import type { NodeSuggestion } from "@/lib/api/boards";

export interface BoardRemoveTarget {
  /** 要删除的节点文本（逐字匹配现有节点；由用户在前端逐项确认后执行）。 */
  text: string;
}

export interface BoardUpdateTarget {
  /** 要改名的现有节点文本（逐字匹配）。 */
  target: string;
  /** 新文本。 */
  text: string;
}

export interface BoardProposal {
  /** 挂载锚点的现有节点文本（逐字匹配）；空串 = 挂在中心主题下。 */
  anchor_text: string;
  children: NodeSuggestion[];
  siblings: NodeSuggestion[];
  /** 建议删除的现有节点（人工逐项确认，agent 不可自行删除）；旧消息无此字段。 */
  remove: BoardRemoveTarget[];
  /** 建议修改文本的现有节点（target→text，人工逐项确认）。 */
  update: BoardUpdateTarget[];
}

export type BoardMsgSegment =
  | { kind: "md"; text: string }
  | { kind: "proposal"; proposal: BoardProposal }
  | { kind: "proposal-pending" };

const FENCE_RE = /```board-nodes[ \t]*\r?\n([\s\S]*?)```/g;
const OPEN_TAG = "```board-nodes";

const MAX_SUGGESTIONS = 12;
const MAX_REMOVE_TARGETS = 12;
const MAX_UPDATE_TARGETS = 12;
const MAX_TEXT_CHARS = 120;

function toSuggestions(items: unknown): NodeSuggestion[] {
  if (!Array.isArray(items)) return [];
  const out: NodeSuggestion[] = [];
  for (const item of items.slice(0, MAX_SUGGESTIONS)) {
    if (typeof item === "string") {
      const text = item.trim().slice(0, MAX_TEXT_CHARS);
      if (text !== "") out.push({ text });
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const text = String(raw.text ?? "").trim().slice(0, MAX_TEXT_CHARS);
    if (text === "") continue;
    const kind = String(raw.kind ?? "text");
    if (kind === "code" && String(raw.code ?? "").trim() !== "") {
      out.push({
        text,
        kind: "code",
        code: String(raw.code),
        language: String(raw.language ?? "").trim() || "text",
      });
    } else if (kind === "md" && String(raw.markdown ?? "").trim() !== "") {
      out.push({ text, kind: "md", markdown: String(raw.markdown) });
    } else {
      out.push({ text, reason: String(raw.reason ?? "").slice(0, MAX_TEXT_CHARS) });
    }
  }
  return out;
}

/** 解析 remove 数组：只取逐字文本，丢弃其余字段（前端匹配只用 text）。 */
function toRemoveTargets(items: unknown): BoardRemoveTarget[] {
  if (!Array.isArray(items)) return [];
  const out: BoardRemoveTarget[] = [];
  for (const item of items.slice(0, MAX_REMOVE_TARGETS)) {
    if (item === null || typeof item !== "object") continue;
    const text = String((item as Record<string, unknown>).text ?? "").trim();
    // 中心主题（空串语义只属于 anchor_text；remove 里出现空串直接丢弃）。
    if (text !== "") out.push({ text: text.slice(0, MAX_TEXT_CHARS) });
  }
  return out;
}

/** 解析 update 数组：target/text 都非空才保留（改文本，人工逐项确认）。 */
function toUpdateTargets(items: unknown): BoardUpdateTarget[] {
  if (!Array.isArray(items)) return [];
  const out: BoardUpdateTarget[] = [];
  for (const item of items.slice(0, MAX_UPDATE_TARGETS)) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const target = String(raw.target ?? "").trim();
    const text = String(raw.text ?? "").trim();
    if (target !== "" && text !== "" && target !== text) {
      out.push({ target: target.slice(0, MAX_TEXT_CHARS), text: text.slice(0, MAX_TEXT_CHARS) });
    }
  }
  return out;
}

/** 解析围栏块 JSON；空建议或格式错误返回 null（调用方按原始文本回退）。 */
export function parseBoardProposal(json: string): BoardProposal | null {
  let data: unknown;
  try {
    data = JSON.parse(json.trim());
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  const children = toSuggestions(raw.children);
  const siblings = toSuggestions(raw.siblings);
  const remove = toRemoveTargets(raw.remove);
  const update = toUpdateTargets(raw.update);
  if (children.length === 0 && siblings.length === 0 && remove.length === 0 && update.length === 0) {
    return null;
  }
  return {
    anchor_text: String(raw.anchor_text ?? "").trim(),
    children,
    siblings,
    remove,
    update,
  };
}

/**
 * 把 assistant 文本切成普通 Markdown 段与建议卡片段。流式期间未闭合的
 * 围栏块渲染为 pending 占位（避免把半截 JSON 当正文闪现）。
 */
export function splitBoardProposalSegments(text: string): BoardMsgSegment[] {
  const segments: BoardMsgSegment[] = [];
  let cursor = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "md", text: text.slice(cursor, match.index) });
    }
    const proposal = parseBoardProposal(match[1] ?? "");
    if (proposal !== null) {
      segments.push({ kind: "proposal", proposal });
    } else {
      // 格式错误的围栏块按原样显示，便于发现 agent 输出问题。
      segments.push({ kind: "md", text: match[0] });
    }
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor);
  const openIdx = rest.indexOf(OPEN_TAG);
  if (openIdx >= 0) {
    if (openIdx > 0) segments.push({ kind: "md", text: rest.slice(0, openIdx) });
    segments.push({ kind: "proposal-pending" });
  } else if (rest !== "") {
    segments.push({ kind: "md", text: rest });
  }
  return segments;
}
