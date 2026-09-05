/**
 * 对话工作区（主页）：左侧会话历史 + 右侧流式聊天。
 *
 * 状态机：draft（activeId=null，首条消息时才真正建会话）→ 发送后乐观插入
 * user 气泡与 pending assistant 气泡，Channel 事件逐 delta 追加、更新来源，
 * done 固化 msgId / error 标失败。切换会话通过 runToken 丢弃在途事件——
 * 后端照常落库，切回时 history 即权威数据。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatAsk,
  createSession,
  deleteSession,
  getHistory,
  listSessions,
  renameSession,
  stopChat,
} from "../../lib/chat";
import type { ChatEvent, ChatSessionRow } from "../../lib/chat";
import type { PendingJump } from "../../lib/router";
import { listProviders, type ProviderStatus } from "../../lib/api-keys";
import { listSkills, type SkillMeta } from "../../lib/skills";
import { toErrorMessage } from "../../lib/updater";
import SessionSidebar from "./SessionSidebar";
import MessageList from "./MessageList";
import SummaryModal from "./SummaryModal";
import SkillMenu from "./SkillMenu";
import type { UiMessage } from "./MessageList";

/** localStorage key remembering the sidebar fold across restarts. */
const RAIL_COLLAPSED_KEY = "mb.chat.rail-collapsed";

/** 对话类提供方 → 显示名（与 API 设置一致）。 */
const CHAT_PROVIDER_LABELS: Record<string, string> = {
  dashscope: "DashScope",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

/** Harness tool names → 中文步骤标签. */
const STEP_LABELS: Record<string, string> = {
  vector_search: "检索",
  list_documents: "查阅知识库",
  search_chat_history: "搜索历史对话",
  get_recent_context: "读取最近对话",
  get_full_history: "读取完整历史",
  get_compressed_summary: "读取会话摘要",
  save_note: "保存笔记",
  list_notes: "查阅笔记列表",
  get_note: "读取笔记",
  update_note: "更新笔记",
  delegate_to_agent: "委托子代理",
};

/** One Step event → a human progress line (query omitted when empty). */
function describeStep(action: string, query: string): string {
  const label = STEP_LABELS[action] ?? action;
  return query === "" ? label : `${label}：${query}`;
}

interface ChatViewProps {
  /** 命令面板的跨视图跳转请求；本视图消费后经 onPendingConsumed 归零。 */
  pending: PendingJump | null;
  onPendingConsumed: () => void;
}

/** Paper-plane glyph for the round send button. */
function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4.5 11.2 19.5 4.8c.5-.2 1 .3.8.8l-6.4 15c-.2.5-.9.5-1.1 0l-2.4-5.6-5.9-2.7c-.5-.2-.5-.9 0-1.1z" strokeLinejoin="round" />
      <path d="m10.4 15 9.9-9.9" strokeLinecap="round" />
    </svg>
  );
}

/** Stop-square glyph for the interrupt button (shown while generating). */
function StopIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}

function ChatView({ pending, onPendingConsumed }: ChatViewProps): React.JSX.Element {
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // True between pressing 停止 and the turn actually finishing.
  const [stopping, setStopping] = useState(false);
  // Crosses into applyEvent so the done frame can mark the manual interrupt.
  const interruptRequestedRef = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [collapsed, setCollapsed] = useState<boolean>(
    () => window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  // 打开中的会话总结弹窗（null = 关闭）。
  const [summaryTarget, setSummaryTarget] = useState<{ id: string; title: string } | null>(null);
  // 对话提供方选择：null = 跟随 API 设置的默认；已配置密钥的对话类提供方才可选。
  const [chatProvider, setChatProvider] = useState<string | null>(null);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerOptions, setProviderOptions] = useState<ProviderStatus[]>([]);
  // 技能：全量清单（菜单数据源）、"/" 菜单状态（query=过滤词 + 高亮下标）、
  // 已附加技能（发送时强制注入本轮，发送后清空）。
  const [allSkills, setAllSkills] = useState<SkillMeta[]>([]);
  const [skillMenu, setSkillMenu] = useState<{ query: string; index: number } | null>(null);
  const [attachedSkill, setAttachedSkill] = useState<SkillMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listProviders().then(
      (statuses) => {
        if (cancelled) return;
        setProviderOptions(statuses.filter((p) => p.hasKey));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // 点击选择器外部时收起菜单。
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!providerMenuOpen) return;
    function onPointerDown(event: PointerEvent): void {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setProviderMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [providerMenuOpen]);

  // Bumped on session switch / new draft; in-flight events with a stale
  // token are dropped (the backend finishes persisting regardless).
  const runToken = useRef(0);
  const localCounter = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer with its content, capped at ~8 lines.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 薄入口页（简历/PPT）经 sessionStorage 带来的草稿：mount 时取走一次，
  // 预填进输入框（不自动发送——用户可能想先补充说明）。
  useEffect(() => {
    const draft = window.sessionStorage.getItem("mb-draft-input");
    if (draft === null || draft === "") return;
    window.sessionStorage.removeItem("mb-draft-input");
    setInput(draft);
    inputRef.current?.focus();
  }, []);

  // Persist the fold decision.
  useEffect(() => {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Ctrl/Cmd+B folds and unfolds the history rail, editor-style.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listSessions().then(
      (rows) => {
        if (cancelled) return;
        setSessions(rows);
        // 点「对话」进入时自动落到最近的会话（列表首位）；但命令面板已
        // 指定目标会话时让位——pending effect 负责选中，避免竞态覆盖。
        if (pending?.kind === "open-session") return;
        if (rows.length > 0) selectSession(rows[0].chatSessionId);
      },
      (err) => {
        if (!cancelled) setLoadError(toErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount 一次性引导，刻意只用初始闭包
  }, []);

  // 命令面板的跨视图跳转：打开指定会话 / 新建对话，消费后归零。
  // 注意：hashchange 异步于 setPending，本视图可能先收到发往其他视图的
  // pending——不属于本视图的 kind 必须原样放行，绝不能消费。
  useEffect(() => {
    if (pending === null) return;
    if (
      pending.kind !== "open-session" &&
      pending.kind !== "new-session" &&
      pending.kind !== "draft"
    ) {
      return;
    }
    if (pending.kind === "open-session" && pending.id !== "") {
      selectSession(pending.id);
    } else if (pending.kind === "new-session") {
      startDraft();
    } else if (pending.kind === "draft") {
      // 薄入口页（简历/PPT）把生成请求带进对话：切回草稿态并预填输入框。
      startDraft();
      setInput(pending.text);
      inputRef.current?.focus();
    }
    onPendingConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pending 变化即消费一次
  }, [pending]);

  // "/" 菜单的过滤结果：只列启用项，名称或描述包含过滤词。
  const filteredSkills =
    skillMenu === null
      ? []
      : allSkills.filter((skill) => {
          if (!skill.enabled) return false;
          const query = skillMenu.query.trim().toLowerCase();
          return (
            query === "" ||
            skill.name.toLowerCase().includes(query) ||
            skill.description.toLowerCase().includes(query)
          );
        });
  const menuIndex =
    skillMenu === null ? 0 : Math.min(skillMenu.index, Math.max(filteredSkills.length - 1, 0));

  /** 选中技能 → 附加到下一轮发送（chip 可移除），清空 "/" 草稿。 */
  function pickSkill(skill: SkillMeta): void {
    setAttachedSkill(skill);
    setInput("");
    setSkillMenu(null);
    inputRef.current?.focus();
  }

  const patchLastAssistant = useCallback(
    (patch: Partial<UiMessage>) => {
      setMessages((prev) => {
        if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });
    },
    [],
  );

  function selectSession(sessionId: string): void {
    if (sessionId === activeId) return;
    const token = ++runToken.current;
    setActiveId(sessionId);
    setMessages([]);
    void getHistory(sessionId).then(
      (rows) => {
        // 过期响应丢弃：快速连续切换会话时，慢的旧历史不得覆盖新会话。
        if (runToken.current !== token) return;
        setMessages(
          rows.map((row) => ({
            id: row.msgId,
            role: row.role,
            content: row.content,
            status: row.status === "failed" ? "failed" : "completed",
            sources: Array.isArray(row.sources) ? row.sources : [],
            error: row.error,
            steps: [],
          })),
        );
      },
      (err) => {
        if (runToken.current === token) setLoadError(toErrorMessage(err));
      },
    );
  }

  /** Draft state: an unnamed conversation created on the first message. */
  function startDraft(): void {
    runToken.current += 1;
    setActiveId(null);
    setMessages([]);
  }

  async function removeSession(sessionId: string): Promise<void> {
    try {
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((session) => session.chatSessionId !== sessionId));
      if (activeId === sessionId) startDraft();
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }

  async function doRename(sessionId: string, title: string): Promise<void> {
    try {
      await renameSession(sessionId, title);
      setSessions((prev) =>
        prev.map((session) =>
          session.chatSessionId === sessionId ? { ...session, title } : session,
        ),
      );
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }

  function applyEvent(event: ChatEvent): void {
    switch (event.type) {
      case "step":
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            steps: [...last.steps, describeStep(event.action, event.query)],
          };
          return next;
        });
        break;
      case "subStep":
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            steps: [
              ...last.steps,
              `子agent步骤（${event.agent}）· ${describeStep(event.action, event.query)}`,
            ],
          };
          return next;
        });
        break;
      case "chunk":
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + event.content };
          return next;
        });
        break;
      case "sources":
        patchLastAssistant({ sources: event.sources });
        break;
      case "title":
        setSessions((prev) =>
          prev.map((session) =>
            session.chatSessionId === activeId ? { ...session, title: event.title } : session,
          ),
        );
        break;
      case "done":
        // A manual interrupt with zero streamed text would otherwise leave an
        // empty bubble — fill in the same marker the backend persists.
        setMessages((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            id: event.msgId,
            status: "completed",
            content:
              interruptRequestedRef.current && last.content.trim() === ""
                ? "（已手动中断本次生成）"
                : last.content,
          };
          return next;
        });
        interruptRequestedRef.current = false;
        break;
      case "error":
        patchLastAssistant({ status: "failed", error: event.message });
        break;
    }
  }

  async function send(text?: string): Promise<void> {
    const question = (text ?? input).trim();
    if (question === "" || busy) return;

    setInput("");
    localCounter.current += 1;

    // Resolve or create the target conversation first.
    let sid = activeId;
    try {
      if (sid === null) {
        const created = await createSession();
        sid = created.chatSessionId;
        setSessions((prev) => [created, ...prev]);
        setActiveId(sid);
      }
    } catch (err) {
      setLoadError(toErrorMessage(err));
      return;
    }

    // Optimistic user bubble; the pending assistant placeholder lives in
    // runTurn so retry can reuse the exact same streaming path.
    const stamp = `${Date.now()}-${localCounter.current}`;
    setMessages((prev) => [
      ...prev,
      { id: `local-user-${stamp}`, role: "user", content: question, status: "completed", sources: [], error: "", steps: [] },
    ]);
    await runTurn(sid, question);
  }

  /** 流式执行一轮对话：插入 pending 占位、消费事件、失败标记。 */
  async function runTurn(targetId: string, question: string): Promise<void> {
    if (busy) return;
    localCounter.current += 1;
    const stamp = `${Date.now()}-${localCounter.current}`;
    setMessages((prev) => [
      ...prev,
      { id: `local-assistant-${stamp}`, role: "assistant", content: "", status: "pending", sources: [], error: "", steps: [] },
    ]);
    setBusy(true);
    interruptRequestedRef.current = false;
    setStopping(false);

    const token = ++runToken.current;
    try {
      await chatAsk(targetId, question, (event) => {
        if (runToken.current === token) applyEvent(event);
      }, chatProvider, attachedSkill?.folder ?? null);
      // 技能是单次注入：随本轮发出后即清除（retry 不带技能）。
      setAttachedSkill(null);
    } catch (err) {
      if (runToken.current === token) {
        patchLastAssistant({ status: "failed", error: toErrorMessage(err) });
      }
    } finally {
      if (runToken.current === token) setBusy(false);
      // Re-sort the sidebar so the active conversation floats to the top.
      void listSessions().then((rows) => setSessions(rows), () => undefined);
    }
  }

  /** 重试失败的回复：沿用其上方的用户消息，移除失败气泡后重新生成。 */
  function retry(messageId: string): void {
    if (busy || activeId === null) return;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 1) return;
    const previous = messages[index - 1];
    if (previous.role !== "user") return;
    const question = previous.content.trim();
    if (question === "") return;
    setMessages((prev) => prev.slice(0, index));
    void runTurn(activeId, question);
  }

  /**
   * 编辑一条用户消息并重新发送（Gemini 式）：丢弃该消息及其后所有本地消息，
   * 以新文本开一轮。会话历史由后端另行追加，本轮不回删旧记录（与重试一致）。
   */
  function editResend(messageId: string, text: string): void {
    if (busy || activeId === null) return;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const question = text.trim();
    if (question === "") return;
    setMessages((prev) => prev.slice(0, index));
    void runTurn(activeId, question);
  }

  return (
    <div className={collapsed ? "chat-layout chat-layout--folded" : "chat-layout"}>
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onSelect={selectSession}
        onCreate={startDraft}
        onRename={(id, title) => void doRename(id, title)}
        onDelete={(id) => void removeSession(id)}
        onSummarize={(id) =>
          setSummaryTarget({
            id,
            title: sessions.find((s) => s.chatSessionId === id)?.title ?? "",
          })
        }
      />
      <div className="chat-main">
        <MessageList
          messages={messages}
          busy={busy}
          onSuggestion={(text) => setInput(text)}
          onRetry={retry}
          onEditResend={editResend}
          onClarify={(text) => void send(text)}
        />
        <div className="composer-wrap">
        {loadError !== "" && <p className="error-text composer__error">{loadError}</p>}
        {attachedSkill !== null && (
          <div className="skill-chip-row">
            <span className="skill-chip" title="该技能全文将随下一条消息强制注入">
              <span className="skill-chip__label">
                技能 · {attachedSkill.name}
                <span className="skill-chip__note">本轮强制注入</span>
              </span>
              <button
                type="button"
                className="skill-chip__remove"
                aria-label="移除技能"
                onClick={() => setAttachedSkill(null)}
              >
                ✕
              </button>
            </span>
          </div>
        )}
        <div className="composer">
          {skillMenu !== null && (
            <SkillMenu
              skills={filteredSkills}
              selectedIndex={menuIndex}
              onPick={pickSkill}
              onHover={(index) => setSkillMenu((prev) => prev && { ...prev, index })}
            />
          )}
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            placeholder={
              busy
                ? "生成中，可继续输入下一问…"
                : activeId === null
                  ? "开始新对话…（输入 / 附加技能）"
                  : "输入问题，Enter 发送（/ 附加技能）"
            }
            value={input}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              if (value.startsWith("/")) {
                setSkillMenu((prev) => ({ query: value.slice(1), index: prev?.index ?? 0 }));
                // 懒刷新：菜单打开时拉最新技能清单（新放入的文件立即可见）。
                void listSkills().then(setAllSkills, () => undefined);
              } else {
                setSkillMenu(null);
              }
            }}
            onKeyDown={(event) => {
              if (skillMenu !== null) {
                if (event.key === "ArrowDown" && filteredSkills.length > 0) {
                  event.preventDefault();
                  setSkillMenu((prev) => prev && { ...prev, index: (menuIndex + 1) % filteredSkills.length });
                  return;
                }
                if (event.key === "ArrowUp" && filteredSkills.length > 0) {
                  event.preventDefault();
                  setSkillMenu((prev) => prev && { ...prev, index: (menuIndex - 1 + filteredSkills.length) % filteredSkills.length });
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSkillMenu(null);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const picked = filteredSkills[menuIndex];
                  if (picked !== undefined) pickSkill(picked);
                  else setSkillMenu(null);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="provider-picker" ref={pickerRef}>
            <button
              type="button"
              className="provider-icon"
              disabled={busy}
              aria-label="选择对话提供方"
              title={
                chatProvider === null
                  ? "对话提供方：默认（跟随 API 设置）"
                  : `对话提供方：${CHAT_PROVIDER_LABELS[chatProvider] ?? chatProvider}`
              }
              onClick={() => {
                setProviderMenuOpen((value) => !value);
                // 每次展开都重拉：在 API 设置里新配的 key 无需重进页面即可出现。
                void listProviders().then(
                  (statuses) => setProviderOptions(statuses.filter((p) => p.hasKey)),
                  () => undefined,
                );
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="m12 3 9 5-9 5-9-5 9-5z" strokeLinejoin="round" />
                <path d="m3 12.5 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m3 17 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {chatProvider !== null && <span className="provider-icon__dot" aria-hidden="true" />}
            </button>
            {providerMenuOpen && (
              <div className="provider-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={
                    chatProvider === null
                      ? "provider-menu__item provider-menu__item--active"
                      : "provider-menu__item"
                  }
                  onClick={() => {
                    setChatProvider(null);
                    setProviderMenuOpen(false);
                  }}
                >
                  默认（跟随 API 设置）
                </button>
                {providerOptions
                  .filter((p) => p.provider in CHAT_PROVIDER_LABELS)
                  .map((p) => (
                    <button
                      key={p.provider}
                      type="button"
                      role="menuitem"
                      className={
                        chatProvider === p.provider
                          ? "provider-menu__item provider-menu__item--active"
                          : "provider-menu__item"
                      }
                      onClick={() => {
                        setChatProvider(p.provider);
                        setProviderMenuOpen(false);
                      }}
                    >
                      {CHAT_PROVIDER_LABELS[p.provider] ?? p.provider}
                      {p.isDefault ? " · 默认" : ""}
                    </button>
                  ))}
                {providerOptions.filter((p) => p.provider in CHAT_PROVIDER_LABELS).length === 0 && (
                  <p className="provider-menu__empty">还没有已配置密钥的对话提供方</p>
                )}
              </div>
            )}
          </div>
          {busy ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              disabled={stopping || activeId === null}
              aria-label={stopping ? "正在中断" : "停止生成"}
              title={stopping ? "正在中断…" : "停止生成"}
              onClick={() => {
                if (activeId === null) return;
                interruptRequestedRef.current = true;
                setStopping(true);
                void stopChat(activeId).catch(() => {
                  interruptRequestedRef.current = false;
                  setStopping(false);
                });
              }}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className={input.trim() === "" ? "composer__send composer__send--muted" : "composer__send"}
              disabled={busy || input.trim() === ""}
              aria-label={busy ? "生成中" : "发送"}
              title="Enter 发送 · Shift+Enter 换行"
              onClick={() => void send()}
            >
              <SendIcon />
            </button>
          )}
        </div>
        </div>
      </div>
      {summaryTarget !== null && (
        <SummaryModal
          sessionId={summaryTarget.id}
          sessionTitle={summaryTarget.title}
          onClose={() => setSummaryTarget(null)}
        />
      )}
    </div>
  );
}

export default ChatView;
