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
import type { ChatMode, ChatSource } from "../../lib/chat";
import { LinkifiedText } from "../../lib/linkify";
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
 * 识别澄清协议（agents.rs 澄清协议约定）：消息含【需要澄清】标记，后跟
 * 「问题：…」与「选项：」下的编号/破折号列表。从**最后一个**标记处解析——
 * 模型偶尔会在标记前先说一句话（如「好的，」）。不匹配时返回 null，消息
 * 按普通 Markdown 渲染。
 *
 * 导出给 ChatView：可点选的候选项渲染在输入框上方（Codex 式），消息体内
 * 只做静态展示。
 */
export function parseClarify(content: string): ClarifyPayload | null {
  const marker = content.lastIndexOf("【需要澄清】");
  if (marker === -1) return null;
  const trimmed = content
    .slice(marker + "【需要澄清】".length)
    .replace(/^\*+/, "")
    .trim();
  let question = "";
  let inOptions = false;
  const options: string[] = [];
  for (const raw of trimmed.split(/\r?\n/).slice(0, 20)) {
    const line = raw.trim().replace(/^\*+|\*+$/g, "");
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
      if (options.length >= 4) break;
    }
  }
  if (question === "" && options.length === 0) return null;
  return { question, options };
}

/**
 * 澄清卡片（消息体内）：只展示问题与方向，**不可点选**——可点选的候选
 * 统一渲染在输入框上方（ClarifyBar，见 ChatView），避免点击区域被消息
 * 布局吞掉、也避免历史消息里的过期选项误导。
 */
function ClarifyCard({ payload }: { payload: ClarifyPayload }): React.JSX.Element {
  return (
    <div className="clarify-card">
      <span className="status status--info">需要澄清</span>
      {payload.question !== "" && <p className="clarify-card__question">{payload.question}</p>}
      {payload.options.length > 0 && (
        <div className="clarify-card__options">
          {payload.options.map((option, index) => (
            <span key={index} className="clarify-card__option clarify-card__option--static">
              {option}
            </span>
          ))}
        </div>
      )}
      <p className="clarify-card__hint">在下方输入框上方点选一个方向（可修改后发送），或直接输入你的说明。</p>
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
      <div className="bubble bubble--user">
        <LinkifiedText text={message.content} />
      </div>
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
    liveAgent,
    planView,
    onRetry,
    onEditResend,
  }: {
    message: UiMessage;
    showCursor: boolean;
    liveAgent: LiveAgentStatus | null;
    planView: PlanView | null;
    onRetry: (messageId: string) => void;
    onEditResend: (messageId: string, text: string) => void;
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
          {message.status === "pending" && liveAgent !== null && (
            <div className="agent-live" role="status">
              <span className="agent-live__dot" aria-hidden="true" />
              <span className="agent-live__name">{liveAgent.name}</span>
              <span className="agent-live__action">
                {liveAgent.step > 0 ? `第 ${liveAgent.step} 步 · ` : ""}
                {liveAgent.action}
              </span>
            </div>
          )}
          {message.status === "pending" && planView !== null && (
            <div className="plan-panel" role="status">
              <div className="plan-panel__head">
                任务计划 v{planView.version} ·{" "}
                {
                  planView.steps.filter(
                    (s) => s.status === "done" || s.status === "skipped",
                  ).length
                }
                /{planView.steps.length} 完成
              </div>
              <ol className="plan-panel__steps">
                {planView.steps.map((step, i) => (
                  <li key={i} className={`plan-step plan-step--${step.status}`}>
                    <span className="plan-step__mark">
                      {PLAN_MARKS[step.status] ?? "·"}
                    </span>
                    <span className="plan-step__desc">{step.desc}</span>
                    {step.note !== "" && (
                      <span className="plan-step__note"> — {step.note}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
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
              // 澄清协议命中 → 静态展示卡片（可点选候选在输入框上方）。
              const clarify = parseClarify(message.content);
              if (clarify !== null) {
                return <ClarifyCard payload={clarify} />;
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

export interface PlanStepView {
  desc: string;
  status: string;
  note: string;
}

export interface PlanView {
  version: number;
  steps: PlanStepView[];
}

const PLAN_MARKS: Record<string, string> = {
  done: "✓",
  in_progress: "▶",
  failed: "✗",
  skipped: "⊘",
  pending: "·",
};

export interface LiveAgentStatus {
  /** 展示名（含子代理标注）。 */
  name: string;
  /** 正在执行的动作描述。 */
  action: string;
  step: number;
}

/** 各对话模式空态的文案与建议（简历/PPT 走专用引导）。 */
const MODE_EMPTY_COPY: Record<
  ChatMode,
  { kicker: string; title: string; text: string; suggestions: string[] }
> = {
  chat: {
    kicker: "MINDBASE · 本地知识库",
    title: "与你的收藏夹对话",
    text: "基于已入库的视频转写内容回答，每条结论都带来源。",
    suggestions: [
      "我的收藏里都讲了哪些内容？",
      "总结一下和检索相关的视频要点",
      "知识库里提到过哪些工具或框架？",
    ],
  },
  resume: {
    kicker: "简历制作模式",
    title: "把对话聊成一份简历",
    text: "把项目细节、技术栈和量化成果聊具体，助手把全部对话提炼成一份 Markdown 简历，存到 exports 文件夹——「简历」页可查所有生成记录。",
    suggestions: [
      "请根据我们的历史对话生成一份简历",
      "我想先聊聊我的项目经历",
      "补充一下我的技术栈和量化成果",
    ],
  },
  slides: {
    kicker: "PPT 制作模式",
    title: "从一个主题到一套 PPT",
    text: "告诉助手主题，它会先检索知识库取材、给出分页大纲，再渲染成 .pptx（含每页要点与讲者备注），存到 exports 文件夹——「PPT」页可查所有生成记录。",
    suggestions: [
      "请帮我制作一套关于「RAG 系统架构与实践」的 PPT",
      "制作一份面向新人的培训课件 PPT",
      "先给这套 PPT 拟一个大纲再动手",
    ],
  },
};

interface MessageListProps {
  messages: UiMessage[];
  /** True while a turn is streaming — drives the typing cursor + autoscroll. */
  busy: boolean;
  /** 对话进行中的实时 agent 状态（谁在干活/正在做什么）；null = 空闲。 */
  liveAgent: LiveAgentStatus | null;
  /** 任务计划面板（plan 工具维护的检查点清单）。 */
  planView: PlanView | null;
  /** 额外的滚动容器类（模式区分：mode-resume / mode-slides）。 */
  className?: string;
  /** 当前对话模式（决定空态文案与建议）。 */
  mode?: ChatMode;
  onSuggestion: (text: string) => void;
  /** 重试一条失败的回复（沿用其上方用户消息重新生成）。 */
  onRetry: (messageId: string) => void;
  /** 编辑一条用户消息并重新发送（丢弃其后所有消息）。 */
  onEditResend: (messageId: string, text: string) => void;
}

function MessageList({
  messages,
  busy,
  liveAgent,
  planView,
  className = "",
  mode = "chat",
  onSuggestion,
  onRetry,
  onEditResend,
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
      <div className={`msg-scroll chat-empty mode-in ${className}`.trim()}>
        <p className="chat-empty__kicker">{MODE_EMPTY_COPY[mode].kicker}</p>
        <h2 className="chat-empty__title">{MODE_EMPTY_COPY[mode].title}</h2>
        <p className="chat-empty__text">{MODE_EMPTY_COPY[mode].text}</p>
        <div className="chat-empty__suggestions">
          {MODE_EMPTY_COPY[mode].suggestions.map((text) => (
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
    <div className={`msg-scroll mode-in ${className}`.trim()} ref={scrollRef}>
      <div className="msg-list">
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            showCursor={showCursor && message === lastMessage}
            liveAgent={message === lastMessage ? liveAgent : null}
            planView={message === lastMessage ? planView : null}
            onRetry={onRetry}
            onEditResend={onEditResend}
          />
        ))}
      </div>
    </div>
  );
}

export default MessageList;
