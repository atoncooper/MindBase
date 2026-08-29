/**
 * 消息列表（编辑式排版）：
 * - user：右对齐 ink 实色气泡，短促、有分量；
 * - assistant：无气泡的通栏文本块，按阅读行宽排版，来源 chips 沉底；
 * - harness 步骤：终端日志风（mono + 左侧发丝线），生成期间可见。
 *
 * 空会话是全屏 hero：mono kicker + 大号细体标题 + 建议问题。
 * 自动滚动只在"用户本就贴近底部"时跟随，避免打断回看。
 */

import { memo, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ChatSource } from "../../lib/chat";
import { MarkdownContent } from "./MarkdownContent";

/** Write text to the clipboard with an execCommand fallback. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 澄清协议解析结果。 */
interface ClarifyPayload {
  question: string;
  options: string[];
}

/**
 * 识别澄清协议（agents.rs 澄清协议约定）：以【需要澄清】开头，后跟
 * 「问题：…」与「选项：」下的编号/破折号列表。不匹配时返回 null，消息
 * 按普通 Markdown 渲染。
 */
function parseClarify(content: string): ClarifyPayload | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("【需要澄清】")) return null;
  let question = "";
  let inOptions = false;
  const options: string[] = [];
  for (const raw of trimmed.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!inOptions && /^问题[:：]?/.test(line)) {
      question = line.replace(/^问题[:：]?\s*/, "");
      continue;
    }
    if (/^选项[:：]?$/.test(line)) {
      inOptions = true;
      continue;
    }
    const match = /^(?:\d+\s*[、.)．)]|[-•*])\s*(.+)$/.exec(line);
    if (inOptions && match !== null) {
      options.push(match[1].trim());
    }
  }
  if (question === "" && options.length === 0) return null;
  return { question, options };
}

/** 澄清卡片：问题 + 可点选的方向；点选即作为新消息发送。 */
function ClarifyCard({
  payload,
  pending,
  onClarify,
}: {
  payload: ClarifyPayload;
  pending: boolean;
  onClarify: (text: string) => void;
}): React.JSX.Element {
  return (
    <div className="clarify-card">
      <span className="status status--info">需要澄清</span>
      {payload.question !== "" && <p className="clarify-card__question">{payload.question}</p>}
      {payload.options.length > 0 && (
        <div className="clarify-card__options">
          {payload.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="clarify-card__option"
              disabled={pending}
              title={pending ? "生成中…" : `就「${option}」继续`}
              onClick={() => onClarify(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <p className="clarify-card__hint">点选一个方向继续，或在下方输入框直接补充说明。</p>
    </div>
  );
}

/** View-model message owned by ChatView. */
export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "completed" | "failed";
  sources: ChatSource[];
  error: string;
  /** Harness progress lines (检索 query), shown while generating. */
  steps: string[];
}

/**
 * 折叠的执行步骤日志：
 * - 生成期间展开，实时进度照旧可见；
 * - 回合完成的瞬间自动收起为一行摘要（用到的工具去重 + 步数），
 *   正文不再被日志顶开，摘要本身即「留下的有用信息」；
 * - 用户可随时手动展开回看完整过程（onToggle 同步状态，手动展开不被覆盖）。
 */
const StepLog = memo(function StepLog({
  steps,
  pending,
}: {
  steps: string[];
  pending: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(pending);
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) setOpen(false);
    wasPending.current = pending;
  }, [pending]);

  // 摘要行：每行取「工具名」（子代理行取括号里的代理名）后去重。
  const tools = Array.from(
    new Set(
      steps.map((line) => {
        if (line.startsWith("子agent步骤")) {
          const match = line.match(/（(.+?)）/);
          return match === null ? "子代理" : `子代理 ${match[1]}`;
        }
        return line.split("：")[0];
      }),
    ),
  );

  return (
    <details
      className="msg-steps"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{tools.join(" · ") || "执行过程"} · {steps.length} 步</summary>
      <ul>
        {steps.map((line, i) => (
          <li
            key={`${i}-${line}`}
            className={line.startsWith("子agent步骤") ? "sub-step" : undefined}
          >
            {line}
          </li>
        ))}
      </ul>
    </details>
  );
});

const SUGGESTIONS: ReadonlyArray<string> = [
  "我的收藏里都讲了哪些内容？",
  "总结一下和检索相关的视频要点",
  "知识库里提到过哪些工具或框架？",
];

function SourceChips({ sources }: { sources: ChatSource[] }): React.JSX.Element | null {
  if (sources.length === 0) return null;
  return (
    <div className="msg-sources">
      {sources.map((source, index) => (
        <button
          key={`${source.bvid}-${index}`}
          type="button"
          className="ws-chip"
          title={source.pageTitle !== "" ? `${source.title} · ${source.pageTitle}` : source.title}
          onClick={() => void openUrl(source.url)}
        >
          【{source.title}】
        </button>
      ))}
    </div>
  );
}

/** 用户消息行：hover 出「编辑 / 复制」；编辑态是行内 textarea + 重发。 */
const UserRow = memo(function UserRow({
  message,
  onEditResend,
}: {
  message: UiMessage;
  onEditResend: (messageId: string, text: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  function commit(): void {
    const text = draft.trim();
    if (text === "") return;
    setEditing(false);
    onEditResend(message.id, text);
  }

  if (editing) {
    return (
      <div className="msg-row msg-row--user">
        <div className="user-edit">
          <textarea
            className="cfg-input user-edit__input"
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <div className="user-edit__actions">
            <button type="button" className="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={draft.trim() === ""}
              onClick={commit}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-row msg-row--user">
      <div className="bubble bubble--user">{message.content}</div>
      <div className="msg-user__actions">
        <button
          type="button"
          className="icon-button"
          aria-label="编辑并重新发送"
          title="编辑并重新发送"
          onClick={() => {
            setDraft(message.content);
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="复制"
          title="复制"
          onClick={() => {
            void copyToClipboard(message.content).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>
    </div>
  );
});

/** 单行消息：memo 化——流式时只有最后一条的对象引用在变，其余行零开销。 */
const MessageRow = memo(
  function MessageRow({
    message,
    showCursor,
    onRetry,
    onEditResend,
    onClarify,
  }: {
    message: UiMessage;
    showCursor: boolean;
    onRetry: (messageId: string) => void;
    onEditResend: (messageId: string, text: string) => void;
    onClarify: (text: string) => void;
  }): React.JSX.Element {
    return message.role === "user" ? (
      <UserRow message={message} onEditResend={onEditResend} />
    ) : (
      <div className="msg-row msg-row--assistant">
        <div
          className={
            message.status === "failed" ? "assistant-block assistant-block--error" : "assistant-block"
          }
        >
          {message.steps.length > 0 && (
            <StepLog steps={message.steps} pending={message.status === "pending"} />
          )}
          {message.content === "" && message.status === "pending" ? (
            <span className="typing-dots" aria-label="正在思考">
              <i />
              <i />
              <i />
            </span>
          ) : (
            ((): React.JSX.Element => {
              // 澄清协议命中 → 交互卡片（流式期间选项逐步出现、置灰）。
              const clarify = parseClarify(message.content);
              if (clarify !== null) {
                return (
                  <ClarifyCard
                    payload={clarify}
                    pending={message.status === "pending"}
                    onClarify={onClarify}
                  />
                );
              }
              return <MarkdownContent content={message.content} streaming={showCursor} />;
            })()
          )}
          {message.status === "failed" && message.error !== "" && (
            <p className="error-text">{message.error}</p>
          )}
          {message.status === "failed" && (
            <button type="button" className="msg-retry" onClick={() => onRetry(message.id)}>
              ↻ 重试
            </button>
          )}
          <SourceChips sources={message.sources} />
        </div>
      </div>
    );
  },
  (a, b) => a.message === b.message && a.showCursor === b.showCursor,
);

interface MessageListProps {
  messages: UiMessage[];
  /** True while a turn is streaming — drives the typing cursor + autoscroll. */
  busy: boolean;
  onSuggestion: (text: string) => void;
  /** 重试一条失败的回复（沿用其上方用户消息重新生成）。 */
  onRetry: (messageId: string) => void;
  /** 编辑一条用户消息并重新发送（丢弃其后所有消息）。 */
  onEditResend: (messageId: string, text: string) => void;
  /** 回应澄清卡片：把所选方向作为新消息发送。 */
  onClarify: (text: string) => void;
}

function MessageList({
  messages,
  busy,
  onSuggestion,
  onRetry,
  onEditResend,
  onClarify,
}: MessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const count = messages.length;
    const prevCount = prevCountRef.current;
    prevCountRef.current = count;
    // 历史一次性载入（含切换会话）/ 用户发出新消息：无条件落到底端——
    // 最新消息即阅读起点；其余情况仅在本就贴近底部时跟随流式追加，
    // 向上回看绝不被拽回。注意 React 批处理会把乐观 user 气泡与
    // assistant 占位合成一次提交，所以要检测「新插入的首条是否为 user」。
    const historyLoaded = prevCount === 0 && count > 1;
    const userSent = count > prevCount && messages[prevCount]?.role === "user";
    if (historyLoaded || userSent) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance < 120) node.scrollTop = node.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="msg-scroll chat-empty">
        <p className="chat-empty__kicker">MINDBASE · 本地知识库</p>
        <h2 className="chat-empty__title">与你的收藏夹对话</h2>
        <p className="chat-empty__text">基于已入库的视频转写内容回答，每条结论都带来源。</p>
        <div className="chat-empty__suggestions">
          {SUGGESTIONS.map((text) => (
            <button key={text} type="button" className="suggest-chip" onClick={() => onSuggestion(text)}>
              {text}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const lastMessage = messages[messages.length - 1];
  const showCursor =
    busy && lastMessage !== undefined && lastMessage.role === "assistant" && lastMessage.status === "pending";

  return (
    <div className="msg-scroll" ref={scrollRef}>
      <div className="msg-list">
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            showCursor={showCursor && message === lastMessage}
            onRetry={onRetry}
            onEditResend={onEditResend}
            onClarify={onClarify}
          />
        ))}
      </div>
    </div>
  );
}

export default MessageList;
