/**
 * Board chat dialog: conversation with the board agent about the current board.
 *
 * Floating dialog centered on screen, draggable by its header. Reuses the
 * global chat SSE pipeline (chatApi.askStream + streamChat); the request
 * carries board_uuid so the backend routes straight to the board agent. The
 * chat session is created before the first message (with retry on failure),
 * independent from the global chat page sessions.
 *
 * UI follows the ChatGPT pattern: right-aligned neutral bubbles for user
 * messages, full-width unstyled text for assistant replies, a pill composer
 * with a circular send / stop button. Loading is explicit: a pulsing dot plus
 * shimmering "thinking" label before the first token, a blinking caret while
 * tokens stream in, and a stop button that aborts generation mid-flight.
 *
 * Assistant messages render through the shared Markdown renderer (GFM +
 * KaTeX); during streaming they emit plain text first and switch to Markdown
 * once done, same strategy as the global chat (no per-token re-parsing).
 * ```board-nodes fenced blocks parse into suggestion cards: when the host
 * (mindmap editor) passes onInsertProposal they can be inserted onto the
 * canvas as ghost nodes (Tab to confirm / Esc to dismiss); hosts without
 * canvas insertion (e.g. whiteboard) omit the callback and the card degrades
 * to display-only.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatApi } from "@/lib/api";
import { streamChat, type StreamStep } from "@/lib/chat-stream";
import { Markdown } from "@/components/markdown";
import {
  splitBoardProposalSegments,
  type BoardMsgSegment,
  type BoardProposal,
} from "./boardProposal";
import type { NodeSuggestion } from "@/lib/api/boards";
import { toErrorMessage } from "./errmsg";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** 思考过程（reasoning 流），折叠展示，展开才渲染内容。 */
  reasoning?: string;
  /** 工具步骤轨迹：LLM 发起（running）→ 节点边界补全（完成）。 */
  steps?: StepEntry[];
  /** 发送时画布选中的节点（仅 user 消息）：建议锚点的精确回执（uid 直取）。 */
  anchorUid?: string;
  anchorText?: string;
}

/** 一次工具调用的可见状态。 */
interface StepEntry {
  step: number;
  action: string;
  query: string;
  running: boolean;
}

/**
 * 把一条 step 帧并入步骤轨迹：新的 step 编号 = 工具发起；已存在的编号 =
 * 该工具在节点边界完成（后端保证先 start 后 completion）。
 */
function applyStep(entries: StepEntry[], frame: StreamStep): StepEntry[] {
  const idx = entries.findIndex((e) => e.step === frame.step);
  if (idx === -1) {
    return [
      ...entries,
      { step: frame.step, action: frame.action, query: frame.query ?? "", running: true },
    ];
  }
  const next = [...entries];
  next[idx] = { ...next[idx], running: false };
  return next;
}

/** Session bootstrap lifecycle: creating → ready, or failed (retryable). */
type SessionState = "creating" | "ready" | "failed";

/** Starter prompts shown on the empty state; clicking one sends it directly. */
const STARTERS = [
  "用一段话解释这块板子的结构和思路",
  "围绕中心主题，补充几个子节点建议",
  "检查这块板子，指出结构上可以改进的地方",
];

/** 板聊插入回调：null = 成功；否则返回给面板展示的错误说明。
 * anchorHint = 发送该消息时画布选中的节点，建议锚点与其文本一致时按 uid 直取。 */
export type InsertProposal = (
  proposal: BoardProposal,
  anchorHint?: { uid: string; text: string }
) => string | null;

type ProposalStatus = "inserted" | "dismissed";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function StopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  );
}

function PinIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M8 14c2.6-3.2 4-5.4 4-7.4A4 4 0 1 0 4 6.6c0 2 1.4 4.2 4 7.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <circle cx="8" cy="6.6" r="1.4" fill="currentColor" />
    </svg>
  );
}

/** Thinking indicator shown before the first streamed token arrives. */
function ThinkingIndicator(): React.JSX.Element {
  return (
    <div className="mm-boardchat-thinking">
      <span className="mm-boardchat-thinking-dot" />
      <span className="mm-boardchat-shimmer">正在思考…</span>
    </div>
  );
}

/**
 * Thinking block: auto-expand ONCE when the first reasoning delta arrives.
 * Auto-expanding on every delta would fight the user's collapse — each token
 * re-expanded the block right after they clicked it shut. While expanded and
 * streaming, the capped inner scroll box follows the bottom (reasoning grows
 * inside it; without following, only the first lines stay visible).
 */
function ThinkingBlock({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);
  const thinkBodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (streaming && reasoning !== "" && !autoExpandedRef.current) {
      autoExpandedRef.current = true;
      setExpanded(true);
    }
  }, [streaming, reasoning]);
  useEffect(() => {
    const el = thinkBodyRef.current;
    if (el !== null && streaming && expanded) el.scrollTop = el.scrollHeight;
  }, [reasoning, streaming, expanded]);

  if (reasoning === "" && !streaming) return null;
  return (
    <div className="mm-boardchat-think">
      <button
        type="button"
        className="mm-boardchat-think-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <svg
          viewBox="0 0 12 12"
          width="10"
          height="10"
          className={`mm-boardchat-think-chevron${expanded ? " mm-boardchat-think-chevron--open" : ""}`}
          aria-hidden="true"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
        {streaming ? (
          <span className="mm-boardchat-shimmer">深度思考中…</span>
        ) : (
          <span>已深度思考</span>
        )}
      </button>
      {expanded && reasoning !== "" && (
        <div ref={thinkBodyRef} className="mm-boardchat-think-body">{reasoning}</div>
      )}
    </div>
  );
}

/** 工具步骤轨迹：进行中的行带脉冲点，完成的行变淡并打勾。 */
function StepList({ steps }: { steps: StepEntry[] }): React.JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <div className="mm-boardchat-steps">
      {steps.map((entry) => (
        <div key={entry.step} className={`mm-boardchat-step${entry.running ? "" : " mm-boardchat-step--done"}`}>
          <span className="mm-boardchat-step-dot" aria-hidden="true" />
          <span className="mm-boardchat-step-action">
            {entry.running ? `调用 ${entry.action}…` : `${entry.action} 完成`}
          </span>
          {entry.query !== "" && (
            <span className="mm-boardchat-step-q" title={entry.query}>
              {truncate(entry.query, 26)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SuggestionChips({ label, items }: { label: string; items: NodeSuggestion[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="mm-bprop-group">
      <span className="mm-bprop-grouplabel">{label}</span>
      <div className="mm-bprop-chips">
        {items.map((item, i) => (
          <span
            key={i}
            className="mm-bprop-chip"
            title={item.kind === "code" ? item.code : item.kind === "md" ? item.markdown : item.text}
          >
            {item.kind === "code" && <span className="mm-bprop-kind">代码</span>}
            {item.kind === "md" && <span className="mm-bprop-kind">MD</span>}
            <span className="mm-bprop-chiptext">{truncate(item.text, 40)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 建议删除目标：每项独立两步确认（点「删除」→「确认」），执行走宿主回调
 * （编辑器 REMOVE_NODE + 正常防抖保存）。没有宿主回调（白板）时只展示。
 * Agent 永远不能自行删除——这是唯一执行入口，确认是硬门控。
 */
function RemoveItem({
  text,
  canApply,
  onApply,
}: {
  text: string;
  canApply: boolean;
  onApply: (target: string) => string | null;
}): React.JSX.Element {
  const [phase, setPhase] = useState<"idle" | "confirm" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const shown = truncate(text, 28);
  if (!canApply) {
    return (
      <span className="mm-bprop-chip" title={text}>
        <span className="mm-bprop-chiptext">{shown}</span>
      </span>
    );
  }
  if (phase === "done") {
    return <span className="mm-bprop-del-done">已删除「{shown}」</span>;
  }
  if (phase === "error") {
    return (
      <span className="mm-bprop-del-confirm">
        <span className="mm-bprop-error">{error}</span>
        <button type="button" className="mm-bprop-delbtn" onClick={() => setPhase("idle")}>
          返回
        </button>
      </span>
    );
  }
  if (phase === "confirm") {
    return (
      <span className="mm-bprop-del-confirm">
        <span>连同子节点删除「{truncate(text, 16)}」？</span>
        <button
          type="button"
          className="mm-bprop-delbtn"
          onClick={() => {
            const result = onApply(text);
            if (result === null) {
              setPhase("done");
            } else {
              setError(result);
              setPhase("error");
            }
          }}
        >
          确认删除
        </button>
        <button type="button" className="mm-bprop-delbtn mm-bprop-delbtn--ghost" onClick={() => setPhase("idle")}>
          取消
        </button>
      </span>
    );
  }
  return (
    <span className="mm-bprop-chip mm-bprop-chip--del" title={text}>
      <span className="mm-bprop-chiptext">{shown}</span>
      <button type="button" className="mm-bprop-delbtn" onClick={() => setPhase("confirm")}>
        删除
      </button>
    </span>
  );
}

/**
 * 建议修改目标：每项独立两步确认（点「修改」→「确认修改」），执行走宿主
 * 回调（编辑器 SET_NODE_TEXT + 正常防抖保存）。没有宿主回调（白板）时只展示。
 */
function UpdateItem({
  target,
  nextText,
  canApply,
  onApply,
}: {
  target: string;
  nextText: string;
  canApply: boolean;
  onApply: (target: string, next: string) => string | null;
}): React.JSX.Element {
  const [phase, setPhase] = useState<"idle" | "confirm" | "done" | "error">("idle");
  const [error, setError] = useState("");
  if (!canApply) {
    return (
      <span className="mm-bprop-chip" title={`${target} → ${nextText}`}>
        <span className="mm-bprop-chiptext">{truncate(target, 20)} → {truncate(nextText, 20)}</span>
      </span>
    );
  }
  if (phase === "done") {
    return <span className="mm-bprop-del-done">已改为「{truncate(nextText, 20)}」</span>;
  }
  if (phase === "error") {
    return (
      <span className="mm-bprop-del-confirm">
        <span className="mm-bprop-error">{error}</span>
        <button type="button" className="mm-bprop-delbtn" onClick={() => setPhase("idle")}>
          返回
        </button>
      </span>
    );
  }
  if (phase === "confirm") {
    return (
      <span className="mm-bprop-del-confirm">
        <span>「{truncate(target, 16)}」→「{truncate(nextText, 16)}」？</span>
        <button
          type="button"
          className="mm-bprop-delbtn"
          onClick={() => {
            const result = onApply(target, nextText);
            if (result === null) {
              setPhase("done");
            } else {
              setError(result);
              setPhase("error");
            }
          }}
        >
          确认修改
        </button>
        <button type="button" className="mm-bprop-delbtn mm-bprop-delbtn--ghost" onClick={() => setPhase("idle")}>
          取消
        </button>
      </span>
    );
  }
  return (
    <span className="mm-bprop-chip mm-bprop-chip--del" title={`${target} → ${nextText}`}>
      <span className="mm-bprop-chiptext">{truncate(target, 16)} → {truncate(nextText, 16)}</span>
      <button type="button" className="mm-bprop-delbtn" onClick={() => setPhase("confirm")}>
        修改
      </button>
    </span>
  );
}

function ProposalCard({
  proposal,
  status,
  canInsert,
  onAction,
  onApplyDeletion,
  onApplyUpdate,
}: {
  proposal: BoardProposal;
  status: ProposalStatus | undefined;
  canInsert: boolean;
  /** 插入/忽略动作；返回 null = 成功，字符串 = 展示在卡片里的错误说明。 */
  onAction: (action: "insert" | "dismiss") => string | null;
  /** 删除目标执行回调；缺省（白板宿主）时删除建议只展示不执行。 */
  onApplyDeletion?: (target: string) => string | null;
  /** 修改目标执行回调；缺省（白板宿主）时修改建议只展示不执行。 */
  onApplyUpdate?: (target: string, nextText: string) => string | null;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const anchorLabel = proposal.anchor_text === "" ? "中心主题" : `「${truncate(proposal.anchor_text, 20)}」`;
  const hasInsertable = proposal.children.length > 0 || proposal.siblings.length > 0;
  const removalEnabled = onApplyDeletion !== undefined && status === undefined;
  const updateEnabled = onApplyUpdate !== undefined && status === undefined;
  return (
    <div className="mm-bprop-card">
      {hasInsertable && (
        <>
          <div className="mm-bprop-head">节点建议 · 挂载在 {anchorLabel}</div>
          <SuggestionChips label="子节点" items={proposal.children} />
          <SuggestionChips label="同级节点" items={proposal.siblings} />
        </>
      )}
      {proposal.update.length > 0 && (
        <div className="mm-bprop-group">
          <span className="mm-bprop-grouplabel">建议修改 · 每项需你确认</span>
          <div className="mm-bprop-chips">
            {proposal.update.map((item, i) => (
              <UpdateItem
                key={`upd${i}`}
                target={item.target}
                nextText={item.text}
                canApply={updateEnabled}
                onApply={onApplyUpdate ?? (() => null)}
              />
            ))}
          </div>
          {onApplyUpdate === undefined && <div className="mm-bprop-status">建议仅展示（当前板子类型不支持修改）</div>}
        </div>
      )}
      {proposal.remove.length > 0 && (
        <div className="mm-bprop-group">
          <span className="mm-bprop-grouplabel">建议删除 · 每项需你确认（连同其子节点移除）</span>
          <div className="mm-bprop-chips">
            {proposal.remove.map((item, i) => (
              <RemoveItem
                key={`del${i}`}
                text={item.text}
                canApply={removalEnabled}
                onApply={onApplyDeletion ?? (() => null)}
              />
            ))}
          </div>
          {onApplyDeletion === undefined && <div className="mm-bprop-status">建议仅展示（当前板子类型不支持删除）</div>}
        </div>
      )}
      {status === undefined ? (
        canInsert && hasInsertable ? (
          <div className="mm-bprop-actions">
            <button
              type="button"
              className="mm-bprop-insert"
              onClick={() => {
                const result = onAction("insert");
                if (result !== null) setError(result);
              }}
            >
              插入画布
            </button>
            <button
              type="button"
              className="mm-bprop-dismiss"
              onClick={() => {
                setError(null);
                onAction("dismiss");
              }}
            >
              忽略
            </button>
          </div>
        ) : !hasInsertable ? null : (
          <div className="mm-bprop-status">建议仅展示（当前板子类型不支持插入）</div>
        )
      ) : (
        hasInsertable && (
          <div className="mm-bprop-status">
            {status === "inserted" ? "已插入为幽灵节点：画布上按 Tab 确认入图，Esc 丢弃" : "已忽略"}
          </div>
        )
      )}
      {error !== null && <div className="mm-bprop-error">{error}</div>}
    </div>
  );
}

function AssistantMessage({
  text,
  streaming,
  reasoning = "",
  steps,
  canInsert,
  onApplyDeletion,
  onApplyUpdate,
  proposalState,
  onProposalAction,
}: {
  text: string;
  streaming: boolean;
  reasoning?: string;
  steps?: StepEntry[];
  canInsert: boolean;
  onApplyDeletion?: (target: string) => string | null;
  onApplyUpdate?: (target: string, nextText: string) => string | null;
  proposalState: (segIndex: number) => ProposalStatus | undefined;
  onProposalAction: (segIndex: number, action: "insert" | "dismiss", proposal: BoardProposal) => string | null;
}): React.JSX.Element {
  if (text === "" && reasoning === "" && (steps?.length ?? 0) === 0) return <></>;
  const segments: BoardMsgSegment[] = splitBoardProposalSegments(text);
  // Attach the streaming caret to the last segment that actually renders, so
  // a trailing empty markdown segment doesn't swallow it.
  let lastVisible = -1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind !== "md" || segment.text.trim() !== "") lastVisible = i;
  }
  return (
    <>
      <ThinkingBlock reasoning={reasoning} streaming={streaming} />
      {/* 步骤轨迹在流结束后保留（只停脉冲）：这是「Agent 到底干过什么」的证据。 */}
      {(steps?.length ?? 0) > 0 && <StepList steps={steps ?? []} />}
      {segments.map((segment, i) => {
        if (segment.kind === "proposal-pending") {
          return (
            <div key={`p${i}`} className="mm-bprop-pending">
              <span className="mm-boardchat-shimmer">正在生成节点建议…</span>
            </div>
          );
        }
        if (segment.kind === "proposal") {
          return (
            <ProposalCard
              key={`p${i}`}
              proposal={segment.proposal}
              status={proposalState(i)}
              canInsert={canInsert}
              onApplyDeletion={onApplyDeletion}
              onApplyUpdate={onApplyUpdate}
              onAction={(action) => onProposalAction(i, action, segment.proposal)}
            />
          );
        }
        if (segment.text.trim() === "") return null;
        if (streaming) {
          // 流式期间纯文本直出（与全局聊天一致：不逐 token 重解析 Markdown）。
          return (
            <div key={`m${i}`} className="mm-boardchat-md mm-boardchat-md--plain">
              {segment.text}
              {i === lastVisible && <span className="mm-boardchat-caret" />}
            </div>
          );
        }
        return (
          <div key={`m${i}`} className="mm-boardchat-md md-body">
            <Markdown>{segment.text}</Markdown>
          </div>
        );
      })}
    </>
  );
}

export function BoardChatPanel({
  boardUuid,
  boardTitle,
  selectedAnchorText,
  selectedAnchorUid,
  onClose,
  onInsertProposal,
  onApplyDeletion,
  onApplyUpdate,
}: {
  boardUuid: string;
  boardTitle: string;
  /** 画布当前选中节点的纯文本（单选时非空）；随消息发给 board agent 作锚点上下文。 */
  selectedAnchorText?: string | null;
  /** 选中节点 uid：随消息存为锚点回执，插入建议时按 uid 直取防同名误锚。 */
  selectedAnchorUid?: string | null;
  onClose: () => void;
  /** 缺省（白板等宿主）时建议卡片只展示、不提供插入按钮。 */
  onInsertProposal?: InsertProposal;
  /** 建议删除的执行回调（编辑器 REMOVE_NODE + 防抖保存）；缺省时只展示。 */
  onApplyDeletion?: (target: string) => string | null;
  /** 建议修改的执行回调（编辑器 SET_NODE_TEXT + 防抖保存）；缺省时只展示。 */
  onApplyUpdate?: (target: string, nextText: string) => string | null;
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>("creating");
  const [retryTick, setRetryTick] = useState(0);
  /** 建议卡片状态，键 = `${消息下标}:${段下标}`。 */
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalStatus>>({});
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // 标题栏拖拽：记录相对屏幕中心的偏移（transform 叠加在居中定位上）。
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const dragRefState = useRef(drag);
  dragRefState.current = drag;

  function onHeadPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).closest("button")) return;
    const current = dragRefState.current;
    dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: current.x, baseY: current.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onHeadPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = dragRef.current;
    if (start === null) return;
    setDrag({ x: start.baseX + (event.clientX - start.startX), y: start.baseY + (event.clientY - start.startY) });
  }

  function onHeadPointerUp(): void {
    dragRef.current = null;
  }

  // 创建板聊专用会话（与全局聊天页的会话互不相干）；失败可在错误行重试。
  // sessionState 只在异步回调/事件处理器里更新，避免 effect 内同步 setState。
  // 同一块板子的多次板聊自动编号（板聊：高数、板聊：高数 #2…），历史里可分。
  useEffect(() => {
    let cancelled = false;
    const base = `板聊：${boardTitle}`.slice(0, 44);
    const numbered = (n: number): string => (n <= 1 ? base : `${base} #${n}`);
    (async () => {
      try {
        const list = await chatApi.listSessions();
        if (cancelled) return;
        const count = list.sessions.filter((s) => {
          const title = s.title ?? "";
          return title === base || title.startsWith(`${base} #`);
        }).length;
        const session = await chatApi.createSession(numbered(count + 1));
        if (cancelled) return;
        sessionRef.current = session.chat_session_id;
        setSessionState("ready");
      } catch (err) {
        if (cancelled) return;
        sessionRef.current = null;
        setSessionState("failed");
        setError(toErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [boardTitle, retryTick]);

  // Sticky bottom: while streaming, follow the growing content. The force
  // disengages when the user scrolls away from the bottom (reading history),
  // and re-engages on programmatic scrolls and on the next send.
  const stickToBottomRef = useRef(true);
  function onBodyScroll(): void {
    const body = bodyRef.current;
    if (body === null) return;
    stickToBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  }
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body !== null && stickToBottomRef.current) body.scrollTop = body.scrollHeight;
  }, [messages, streaming]);

  // Composer auto-grow: reset then clamp to the max height on every input.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  function send(raw?: string): void {
    const question = (raw ?? input).trim();
    if (question === "" || streaming) return;
    if (sessionState !== "ready" || sessionRef.current === null) {
      setError("会话尚未就绪，请稍候再试");
      return;
    }
    const sessionId: string = sessionRef.current;
    const anchorText = (selectedAnchorText ?? "").trim();

    setError(null);
    setInput("");
    const anchorUid = (selectedAnchorUid ?? "").trim();
    const history = [
      ...messagesRef.current,
      {
        role: "user" as const,
        text: question,
        // 锚点回执：本回合选中节点的 uid+文本，插入建议时按 uid 直取。
        ...(anchorText !== "" && anchorUid !== "" ? { anchorUid, anchorText } : {}),
      },
    ];
    setMessages([...history, { role: "assistant", text: "" }]);
    setStreaming(true);
    stickToBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const assistantIndex = history.length;

    void chatApi
      .askStream(
        {
          question,
          chat_session_id: sessionId,
          board_uuid: boardUuid,
          ...(anchorText !== "" ? { board_anchor_text: anchorText } : {}),
        },
        controller.signal
      )
      .then((stream) =>
        streamChat(
          stream,
          {
            onChunk: (accumulated) => {
              setMessages((prev) => {
                const next = [...prev];
                const cur = next[assistantIndex] ?? { role: "assistant" as const, text: "" };
                next[assistantIndex] = { ...cur, role: "assistant", text: accumulated };
                return next;
              });
            },
            onReasoning: (accumulated) => {
              setMessages((prev) => {
                const next = [...prev];
                const cur = next[assistantIndex] ?? { role: "assistant" as const, text: "" };
                next[assistantIndex] = { ...cur, role: "assistant", reasoning: accumulated };
                return next;
              });
            },
            onStep: (frame) => {
              setMessages((prev) => {
                const next = [...prev];
                const cur = next[assistantIndex] ?? { role: "assistant" as const, text: "" };
                next[assistantIndex] = {
                  ...cur,
                  role: "assistant",
                  steps: applyStep(cur.steps ?? [], frame),
                };
                return next;
              });
            },
            onReset: () => {
              // A retried LLM run begins: the backend replays pre-run
              // content as chunks right after. We do NOT touch the message
              // here — any setMessages call risks a React batching race
              // where reasoning gets lost between the updater and the next
              // onReasoning/onChunk callback.
            },
            onError: (message) => {
              // Keep any partial reply; the empty placeholder is dropped below.
              setError(message);
            },
          },
          controller.signal
        )
      )
      .catch((err) => {
        // Stop (abort) is a user action, not a failure.
        if (isAbortError(err)) return;
        setError(toErrorMessage(err));
      })
      .finally(() => {
        setStreaming(false);
        abortRef.current = null;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // Drop an assistant placeholder that never received content (stopped
          // before the first token or failed outright) instead of a blank bubble.
          if (
            last !== undefined &&
            last.role === "assistant" &&
            last.text === "" &&
            (last.reasoning ?? "") === "" &&
            (last.steps?.length ?? 0) === 0
          ) {
            return prev.slice(0, -1);
          }
          // Stream over: any step still "running" (stream cut mid-tool, or
          // stop pressed) is finalized as done so the retained trail does
          // not show a stale pulse forever.
          if (last !== undefined && last.role === "assistant" && last.steps?.some((s) => s.running)) {
            const next = [...prev];
            next[next.length - 1] = {
              ...last,
              steps: last.steps.map((s) => (s.running ? { ...s, running: false } : s)),
            };
            return next;
          }
          return prev;
        });
      });
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  function retrySession(): void {
    setError(null);
    setSessionState("creating");
    setRetryTick((tick) => tick + 1);
  }

  // Composer 上方的选中上下文 chip（同时是发送时携带的锚点文本）。
  const anchorChip = (selectedAnchorText ?? "").trim();

  return (
    <div
      className="mm-boardchat-panel"
      style={{ transform: `translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))` }}
    >
      <div
        className="mm-boardchat-head"
        onPointerDown={onHeadPointerDown}
        onPointerMove={onHeadPointerMove}
        onPointerUp={onHeadPointerUp}
      >
        <div className="mm-boardchat-headtext">
          <span className="mm-boardchat-title">板聊</span>
          <span className="mm-boardchat-sub">{boardTitle || "未命名板子"}</span>
        </div>
        <button type="button" className="mm-boardchat-close" title="关闭" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="mm-boardchat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && (
          <div className="mm-boardchat-empty">
            <div className="mm-boardchat-empty-title">关于这块板子，想聊点什么？</div>
            {sessionState === "creating" && <div className="mm-boardchat-empty-hint">正在准备会话…</div>}
            {sessionState === "failed" && (
              <div className="mm-boardchat-empty-hint">会话创建失败，可在下方重试</div>
            )}
            {sessionState === "ready" && (
              <div className="mm-boardchat-starters">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    className="mm-boardchat-starter"
                    onClick={() => send(starter)}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message, index) => {
          const messageStreaming = streaming && index === messages.length - 1;
          if (message.role === "user") {
            return (
              <div key={index} className="mm-boardchat-msg mm-boardchat-msg--user">
                {message.text}
              </div>
            );
          }
          return (
            <div key={index} className="mm-boardchat-msg mm-boardchat-msg--assistant">
              {messageStreaming && message.text === "" && !(message.reasoning ?? "") && !(message.steps?.length) ? (
                <ThinkingIndicator />
              ) : (
                <AssistantMessage
                  text={message.text}
                  streaming={messageStreaming}
                  reasoning={message.reasoning}
                  steps={message.steps}
                  canInsert={onInsertProposal !== undefined}
                  onApplyDeletion={onApplyDeletion}
                  onApplyUpdate={onApplyUpdate}
                  proposalState={(segIndex) => proposalStates[`${index}:${segIndex}`]}
                  onProposalAction={(segIndex, action, proposal) => {
                    if (action === "dismiss") {
                      setProposalStates((prev) => ({ ...prev, [`${index}:${segIndex}`]: "dismissed" }));
                      return null;
                    }
                    if (onInsertProposal === undefined) return "当前板子类型不支持插入";
                    // 本条回复对应的用户消息若带锚点回执，插入时按 uid 直取。
                    const paired = index > 0 ? messagesRef.current[index - 1] : undefined;
                    const anchorHint =
                      paired !== undefined && paired.role === "user" && paired.anchorUid
                        ? { uid: paired.anchorUid, text: paired.anchorText ?? "" }
                        : undefined;
                    const result = onInsertProposal(proposal, anchorHint);
                    if (result === null) {
                      setProposalStates((prev) => ({ ...prev, [`${index}:${segIndex}`]: "inserted" }));
                    }
                    return result;
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {error !== null && (
        <div className="mm-boardchat-error">
          <span className="mm-boardchat-error-text">{error}</span>
          {sessionState === "failed" && (
            <button type="button" className="mm-boardchat-error-retry" onClick={retrySession}>
              重试
            </button>
          )}
        </div>
      )}
      {anchorChip !== "" && (
        <div className="mm-boardchat-anchor" title="当前选中的节点会作为建议的挂载锚点">
          <PinIcon />
          <span className="mm-boardchat-anchor-text">{truncate(anchorChip, 24)}</span>
        </div>
      )}
      <div className="mm-boardchat-composer">
        <textarea
          ref={inputRef}
          className="mm-boardchat-input"
          placeholder="输入消息，Enter 发送"
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {streaming ? (
          <button type="button" className="mm-boardchat-send mm-boardchat-send--stop" title="停止生成" onClick={stop}>
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="mm-boardchat-send"
            title="发送"
            disabled={input.trim() === "" || sessionState !== "ready"}
            onClick={() => send()}
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}
