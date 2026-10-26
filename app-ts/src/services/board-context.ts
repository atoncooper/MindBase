import type { PromptRegistry } from "../agent/prompts/loader.js";

/**
 * Board (mindmap / whiteboard) chat context: BoardChatPanel sends
 * board_uuid + board_anchor_text with the turn — "the user asked this from inside
 * board X, at node Y". Both fields are USER INPUT, so they are sanitized and
 * length-capped at the HTTP boundary and only ever reach the agent as a controlled
 * systemPrompt section (never as tool arguments or identity).
 *
 * The LLM-facing copy lives in prompts/chat/board-context.md (repo convention:
 * prompt text belongs to prompts/, business code only renders it).
 */

/** board_uuid is opaque but backend-issued (hex/uuid); cap + charset-filter it. */
export const BOARD_UUID_MAX = 64;
/** Node label: display-only context, capped hard. */
export const BOARD_ANCHOR_TEXT_MAX = 200;

export interface BoardContextParams {
  /** sanitized board uuid (<= 64 chars, [A-Za-z0-9_-] only) */
  uuid: string;
  /** sanitized anchor/node label (<= 200 chars); absent when the client omitted it */
  anchorText?: string;
}

/** Collapse whitespace + drop control chars so user text cannot forge prompt sections. */
function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // 角括号是提示词模板里「节点」的定界符：用用户文本关掉它就能伪造后续段落。
    .replace(/[「」]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * Parse the optional board params off a chat request body.
 * Returns undefined when there is no usable board_uuid — absent fields never fail
 * the turn (the old clients simply keep working).
 */
export function parseBoardContext(body: {
  board_uuid?: unknown;
  board_anchor_text?: unknown;
}): BoardContextParams | undefined {
  if (typeof body.board_uuid !== "string") return undefined;
  const uuid = sanitizeText(body.board_uuid, BOARD_UUID_MAX).replace(/[^A-Za-z0-9_-]/g, "");
  if (!uuid) return undefined;
  const anchorText =
    typeof body.board_anchor_text === "string"
      ? sanitizeText(body.board_anchor_text, BOARD_ANCHOR_TEXT_MAX)
      : "";
  return anchorText ? { uuid, anchorText } : { uuid };
}

/** Render the controlled board-context system directive for this turn. */
export function buildBoardSystemSection(
  prompts: PromptRegistry,
  board: BoardContextParams,
): string {
  return prompts.render("chat/board-context", {
    BOARD_UUID: board.uuid,
    // whole clause (or empty) so the sentence stays grammatical without an anchor
    BOARD_NODE: board.anchorText ? `，在节点「${board.anchorText}」` : "",
  });
}
