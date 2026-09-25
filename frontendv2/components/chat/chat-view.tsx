"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { ChatSidebar } from "./chat-sidebar";
import { ChatHeader } from "./chat-header";
import ChatMessage from "./chat-message";
import { ChatInput, type SelectedSkill } from "./chat-input";
import { ChatEmpty } from "./chat-empty";
import { SummaryModal } from "./summary-modal";
import { QuizFromSummaryDialog } from "./quiz-from-summary-dialog";
import { chatApi, type ChatSession, type ChatMessage as ApiChatMessage } from "@/lib/api";
import { streamChat, type ChatSource, type ChatArtifact, type StreamStep } from "@/lib/chat-stream";
import type { ChatMessageData, ChatSessionSummary } from "./types";

// Stable empty array so `messages` doesn't change identity on every render
// (which would re-trigger the auto-scroll effect needlessly).
const EMPTY_MESSAGES: ChatMessageData[] = [];

// Local UI session shape - maps backend ChatSession + holds loaded messages.
interface UISession {
  id: string; // chat_session_id from backend
  title: string;
  lastMessageAt: string;
  messages: ChatMessageData[];
  historyLoaded: boolean;
}

function toUIMessage(m: ApiChatMessage): ChatMessageData {
  return {
    id: m.msg_id,
    role: m.role === "system" ? "assistant" : m.role,
    content: m.content,
    // Backend may return null; normalize to array.
    sources: Array.isArray(m.sources) ? m.sources : undefined,
    // Binary outputs (run_code images) persisted on the message; without
    // this mapping, reloading history loses the images (SSE-only display).
    artifacts: Array.isArray(m.artifacts) ? m.artifacts : undefined,
    status: m.status,
    error: m.error,
    timestamp: m.created_at,
  };
}

function toUISession(s: ChatSession): UISession {
  return {
    id: s.chat_session_id,
    title: s.title || "新对话",
    lastMessageAt: s.last_message_at || s.updated_at || s.created_at,
    messages: [],
    historyLoaded: false,
  };
}

// Client-side placeholder ids ("user-*"/"assistant-*"/"load-err") vs real
// backend msg_ids (UUIDs, used by history-loaded messages directly).
function isLocalId(id: string): boolean {
  return id.startsWith("user-") || id.startsWith("assistant-") || id === "load-err";
}

// Server addressable id of a message: serverId if backfilled, else the id
// itself when it already is a backend msg_id (history-loaded rows).
function anchorIdOf(m: ChatMessageData): string | undefined {
  if (m.serverId) return m.serverId;
  return isLocalId(m.id) ? undefined : m.id;
}

export function ChatView() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [quizDialogOpen, setQuizDialogOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<SelectedSkill[]>([]);
  // Which user message is currently being edited inline (at most one).
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages ?? EMPTY_MESSAGES;

  // Track which sessions have had their history fetched, so the load effect can
  // depend only on activeSessionId (not the whole sessions array, which changes
  // on every streamed token and would re-trigger the effect).
  const loadedRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const updateActiveSession = useCallback((updater: (s: UISession) => UISession) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? updater(s) : s))
    );
  }, [activeSessionId]);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await chatApi.listSessions();
      const mapped = res.sessions.map(toUISession);
      // Preserve any already-loaded messages by merging on id.
      setSessions((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        return mapped.map((s) => {
          const existing = byId.get(s.id);
          return existing
            ? { ...s, messages: existing.messages, historyLoaded: existing.historyLoaded }
            : s;
        });
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载会话列表失败");
    }
  }, []);

  // ---- On mount: load sessions, auto-create first one if empty ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await chatApi.listSessions();
        if (cancelled) return;
        const mapped = res.sessions.map(toUISession);
        setSessions(mapped);
        if (mapped.length > 0) {
          setActiveSessionId(mapped[0].id);
        } else {
          // No sessions exist - create the first one.
          try {
            const created = await chatApi.createSession();
            if (cancelled) return;
            const ui = toUISession(created);
            ui.historyLoaded = true; // empty, no need to fetch history
            loadedRef.current.add(ui.id);
            setSessions([ui]);
            setActiveSessionId(ui.id);
          } catch (e) {
            setLoadError(e instanceof Error ? e.message : "创建会话失败");
          }
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "加载会话列表失败");
      } finally {
        if (!cancelled) setIsLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Load message history when active session changes (once per session) ----
  useEffect(() => {
    if (!activeSessionId) return;
    if (loadedRef.current.has(activeSessionId)) return;
    loadedRef.current.add(activeSessionId);

    let cancelled = false;
    (async () => {
      try {
        const res = await chatApi.getHistory(activeSessionId);
        if (cancelled) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? { ...s, messages: res.messages.map(toUIMessage), historyLoaded: true }
              : s
          )
        );
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "加载历史消息失败";
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  historyLoaded: true,
                  messages: [
                    {
                      id: "load-err",
                      role: "assistant",
                      content: "",
                      status: "failed",
                      error: msg,
                      timestamp: new Date().toISOString(),
                    },
                  ],
                }
              : s
          )
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // ---- Auto-scroll with stick-to-bottom (rAF-throttled) ----
  // Follow the stream only while the user is already near the bottom; once
  // they scroll up to read, stop yanking the viewport and offer a jump-back
  // button instead.
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!stickToBottomRef.current) return;
      messagesEndRef.current?.scrollIntoView({
        behavior: isStreaming ? "auto" : "smooth",
      });
    });
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, isStreaming]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    setShowJumpToBottom(distance > 240);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  // ---- Backfill real backend msg_ids after a streamed turn ----
  // The SSE protocol carries no msg_ids, so freshly-streamed messages only
  // have local placeholder ids. Once the turn settles, pair the local list
  // with server history (same order) and record each message's real id as
  // `serverId`, which per-turn regenerate needs to truncate server history.
  // Best-effort: on any mismatch (desync) or fetch error, keep local state.
  const backfillMessageIds = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      let res = await chatApi.getHistory(activeSessionId, 1, 100);
      if (res.total > res.messages.length && res.messages.length === 100) {
        // Long session: the fresh turns sit on the last page.
        res = await chatApi.getHistory(activeSessionId, Math.ceil(res.total / 100), 100);
      }
      const server = res.messages;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeSessionId || server.length !== s.messages.length) return s;
          let aligned = true;
          const next = s.messages.map((m, i) => {
            const sm = server[i];
            if (sm.role !== m.role) {
              aligned = false;
              return m;
            }
            return m.id === sm.msg_id ? m : { ...m, serverId: sm.msg_id };
          });
          return aligned ? { ...s, messages: next } : s;
        })
      );
    } catch {
      // History fetch is best-effort; regenerate simply stays unavailable
      // for the affected turns until the next successful backfill.
    }
  }, [activeSessionId]);

  // ---- Core: stream a question into the active session ----
  const streamQuestion = useCallback(
    async (question: string, assistantMsgId: string, skillIds?: string[]) => {
      if (!activeSessionId) return;
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      // Throttled stream flush: SSE deltas arrive far faster than markdown
      // should be re-parsed, so the newest content/reasoning is held here and
      // committed to state at most every ~80ms (plus a final flush at the end
      // of the stream so no trailing delta is lost).
      let latestContent = "";
      let latestReasoning = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushPending = false;

      const flushStream = () => {
        if (flushTimer != null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!flushPending) return;
        flushPending = false;
        const content = latestContent;
        const reasoning = latestReasoning;
        updateActiveSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, content, reasoning } : m
          ),
        }));
      };

      const scheduleFlush = () => {
        flushPending = true;
        if (flushTimer == null) {
          flushTimer = setTimeout(flushStream, 80);
        }
      };

      try {
        const stream = await chatApi.askStream(
          {
            question,
            chat_session_id: activeSessionId,
            ...(skillIds && skillIds.length > 0 ? { skill_ids: skillIds } : {}),
          },
          controller.signal
        );

        await streamChat(
          stream,
          {
            onChunk: (accumulated) => {
              latestContent = accumulated;
              scheduleFlush();
            },
            onSources: (sources: ChatSource[]) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, sources } : m
                ),
              }));
            },
            onArtifact: (artifact: ChatArtifact) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const existing = m.artifacts ?? [];
                  const key = artifact.url || artifact.name;
                  if (key && existing.some((a) => (a.url || a.name) === key)) return m;
                  return { ...m, artifacts: [...existing, artifact] };
                }),
              }));
            },
            onRoute: (agent: string) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, agent } : m
                ),
              }));
            },
            onReset: () => {
              // A retried LLM run begins: clear the buffered content (the
              // backend replays pre-run content as chunks) and flush
              // immediately so no stale text lingers for up to 80ms.
              latestContent = "";
              flushPending = true;
              flushStream();
            },
            onReasoning: (accumulated) => {
              latestReasoning = accumulated;
              scheduleFlush();
            },
            onStep: (step: StreamStep) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const existing = m.reasoningSteps ?? [];
                  const idx = existing.findIndex((r) => r.step === step.step);
                  if (idx >= 0) {
                    const next = [...existing];
                    next[idx] = {
                      ...next[idx],
                      action: step.action || next[idx].action,
                      query: step.query || next[idx].query,
                      reasoning: step.reasoning || next[idx].reasoning,
                      sources: step.sources?.length ? step.sources : next[idx].sources,
                    };
                    return { ...m, reasoningSteps: next };
                  }
                  return {
                    ...m,
                    reasoningSteps: [
                      ...existing,
                      {
                        step: step.step,
                        action: step.action,
                        query: step.query,
                        reasoning: step.reasoning,
                        sources: step.sources ?? [],
                      },
                    ],
                  };
                }),
              }));
            },
            onError: (message: string) => {
              flushStream();
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, status: "failed", error: message } : m
                ),
              }));
            },
            onComplete: () => {
              flushStream();
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId && m.status === "pending" ? { ...m, status: "completed" } : m
                ),
              }));
            },
          },
          controller.signal
        );

        // Refresh session list (title may be auto-generated by backend)
        refreshSessions();
      } catch (error) {
        // Aborted by user (stop) - not an error; handleStop already finalized the msg.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        flushStream();
        const message = error instanceof Error ? error.message : "请求失败";
        updateActiveSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, status: "failed", error: message } : m
          ),
        }));
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        void backfillMessageIds();
      }
    },
    [activeSessionId, updateActiveSession, refreshSessions, backfillMessageIds]
  );

  // ---- Send a message (skillIds: forced-inject skills for this turn only) ----
  const handleSend = useCallback(
    (userMessage: string, skillIds?: string[]) => {
      if (!activeSessionId) return;

      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now() + 1}`;
      const timestamp = new Date().toISOString();

      updateActiveSession((s) => ({
        ...s,
        lastMessageAt: timestamp,
        messages: [
          ...s.messages,
          { id: userMsgId, role: "user", content: userMessage, status: "completed", timestamp },
          { id: assistantMsgId, role: "assistant", content: "", status: "pending", timestamp },
        ],
      }));

      void streamQuestion(userMessage, assistantMsgId, skillIds);
      // Skills are per-turn (Claude-Code-style): consumed by this message.
      if (skillIds && skillIds.length > 0) setSelectedSkills([]);
    },
    [activeSessionId, updateActiveSession, streamQuestion]
  );

  // ---- Slash-menu skill toggle (chips above the input) ----
  const handleToggleSkill = useCallback((skill: SelectedSkill) => {
    setSelectedSkills((prev) =>
      prev.some((s) => s.skill_id === skill.skill_id)
        ? prev.filter((s) => s.skill_id !== skill.skill_id)
        : [...prev, skill]
    );
  }, []);

  // ---- Regenerate a specific turn (per-turn rewrite) ----
  // Truncates server history from the turn's user message onward (the turn
  // itself and everything after it), then re-asks that question. Requires
  // the turn to be server-addressable (real msg_id backfilled from history).
  const handleRegenerate = useCallback(
    async (assistantMsgId: string) => {
      if (!activeSessionId || isStreaming) return;
      const sess = sessions.find((s) => s.id === activeSessionId);
      if (!sess) return;
      const idx = sess.messages.findIndex((m) => m.id === assistantMsgId);
      if (idx < 1) return;
      const prevUser = sess.messages[idx - 1];
      if (prevUser.role !== "user") return;
      const anchorId = anchorIdOf(prevUser);
      if (!anchorId) return;

      try {
        await chatApi.truncateHistoryFrom(activeSessionId, anchorId);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "重写失败，请稍后重试");
        return;
      }

      const timestamp = new Date().toISOString();
      const userMsgId = `user-${Date.now()}`;
      const newAssistantId = `assistant-${Date.now() + 1}`;
      updateActiveSession((s) => ({
        ...s,
        messages: [
          ...s.messages.slice(0, idx - 1),
          {
            id: userMsgId,
            role: "user",
            content: prevUser.content,
            status: "completed",
            timestamp,
          },
          {
            id: newAssistantId,
            role: "assistant",
            content: "",
            status: "pending",
            timestamp,
          },
        ],
      }));
      void streamQuestion(prevUser.content, newAssistantId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  // ---- Edit a user message (ChatGPT-style rewrite from that turn) ----
  // Truncates server history from the edited user message (inclusive), then
  // re-asks with the new content. Requires a server-addressable msg_id.
  const handleEditUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeSessionId || isStreaming) return;
      const content = newContent.trim();
      if (!content) return;
      const sess = sessions.find((s) => s.id === activeSessionId);
      if (!sess) return;
      const idx = sess.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const target = sess.messages[idx];
      if (target.role !== "user" || content === target.content) return;
      const anchorId = anchorIdOf(target);
      if (!anchorId) return;

      try {
        await chatApi.truncateHistoryFrom(activeSessionId, anchorId);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "编辑失败，请稍后重试");
        return;
      }

      const timestamp = new Date().toISOString();
      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now() + 1}`;
      updateActiveSession((s) => ({
        ...s,
        messages: [
          ...s.messages.slice(0, idx),
          {
            id: userMsgId,
            role: "user",
            content,
            status: "completed",
            timestamp,
          },
          {
            id: assistantMsgId,
            role: "assistant",
            content: "",
            status: "pending",
            timestamp,
          },
        ],
      }));
      void streamQuestion(content, assistantMsgId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    updateActiveSession((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.status !== "pending") return m;
        // A stop with nothing streamed leaves a blank bubble; surface it as
        // an explicit failure so the user sees what happened and can retry.
        return m.content
          ? { ...m, status: "completed" }
          : { ...m, status: "failed", error: "已停止生成" };
      }),
    }));
  }, [updateActiveSession]);

  // ---- New chat: create backend session ----
  const handleNewChat = useCallback(async () => {
    try {
      const res = await chatApi.createSession();
      const ui = toUISession(res);
      ui.historyLoaded = true;
      loadedRef.current.add(ui.id);
      setSessions((prev) => [ui, ...prev]);
      setActiveSessionId(res.chat_session_id);
      setEditingMessageId(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "创建会话失败");
    }
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    // Fresh session view starts pinned to the bottom.
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    setEditingMessageId(null);
    // 桌面端（md+，≥768px）侧边栏常驻，选中会话不能把它收起变窄；
    // 仅移动端覆盖式抽屉需要选中后自动关闭。
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      setSidebarOpen(false);
    }
  }, []);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await chatApi.deleteSession(sessionId);
        loadedRef.current.delete(sessionId);
        setSessions((prev) => {
          const next = prev.filter((s) => s.id !== sessionId);
          if (activeSessionId === sessionId) {
            setActiveSessionId(next[0]?.id ?? null);
          }
          return next;
        });
        // If we deleted the last session, create a fresh one.
        if (sessions.length <= 1) {
          const created = await chatApi.createSession();
          const ui = toUISession(created);
          ui.historyLoaded = true;
          loadedRef.current.add(ui.id);
          setSessions([ui]);
          setActiveSessionId(created.chat_session_id);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "删除会话失败");
      }
    },
    [activeSessionId, sessions.length]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        await chatApi.updateSession(sessionId, { title: newTitle });
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
        );
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "重命名会话失败");
      }
    },
    []
  );

  const handleClearChat = useCallback(() => {
    if (!activeSessionId) return;
    updateActiveSession((s) => ({ ...s, messages: [] }));
  }, [activeSessionId, updateActiveSession]);

  // ---- ⌘N / Ctrl+N: new chat ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void handleNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewChat]);

  const sidebarSessions: ChatSessionSummary[] = isLoadingSessions
    ? []
    : sessions.map((s) => ({ id: s.id, title: s.title, lastMessageAt: s.lastMessageAt }));

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden">
      <ChatSidebar
        sessions={sidebarSessions}
        activeSessionId={activeSessionId ?? undefined}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={activeSession?.title ?? "MindBase"}
          hasMessages={messages.length > 0}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onClearChat={handleClearChat}
          onSummarize={() => setSummaryOpen(true)}
        />

        {loadError && (
          <div className="border-b border-danger/10 bg-danger/5 px-4 py-2 text-[12px] text-danger">
            {loadError}
          </div>
        )}

        {/* Messages scroll area */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
            {messages.length === 0 ? (
              <ChatEmpty onSuggestionClick={handleSend} />
            ) : (
              <div className="mx-auto max-w-[768px] space-y-5 px-5 py-6">
                {messages.map((message, i) => {
                  const prev = messages[i - 1];
                  const regenAnchor =
                    prev && prev.role === "user" ? anchorIdOf(prev) : undefined;
                  const canRegenerate =
                    message.role === "assistant" &&
                    (message.status === "completed" || message.status === "failed") &&
                    !!regenAnchor;
                  const editAnchor =
                    message.role === "user" ? anchorIdOf(message) : undefined;
                  const canEdit = !isStreaming && !!editAnchor;
                  return (
                    <ChatMessage
                      key={message.id}
                      role={message.role}
                      content={message.content}
                      sources={message.sources}
                      artifacts={message.artifacts}
                      reasoningSteps={message.reasoningSteps}
                      reasoning={message.reasoning}
                      agent={message.agent}
                      status={message.status}
                      error={message.error}
                      timestamp={message.timestamp}
                      onRegenerate={
                        canRegenerate
                          ? () => void handleRegenerate(message.id)
                          : undefined
                      }
                      onEdit={canEdit ? () => setEditingMessageId(message.id) : undefined}
                      isEditing={editingMessageId === message.id}
                      onEditSubmit={(content) => {
                        setEditingMessageId(null);
                        void handleEditUserMessage(message.id, content);
                      }}
                      onEditCancel={() => setEditingMessageId(null)}
                    />
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Jump back to the live bottom when the user scrolled up */}
          {showJumpToBottom && (
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="absolute bottom-4 left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border-subtle bg-surface text-secondary shadow-sm transition-colors hover:text-foreground"
              aria-label="回到底部"
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Input area */}
        <div className="shrink-0 px-5 pt-2 pb-2">
          <div className="mx-auto max-w-[768px]">
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming || !activeSessionId}
              isStreaming={isStreaming}
              onStop={handleStop}
              selectedSkills={selectedSkills}
              onToggleSkill={handleToggleSkill}
              onOpenQuizWizard={() => setQuizDialogOpen(true)}
            />
          </div>
        </div>
      </main>

      <SummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        chatSessionId={activeSessionId}
      />

      <QuizFromSummaryDialog
        open={quizDialogOpen}
        onClose={() => setQuizDialogOpen(false)}
        chatSessionId={activeSessionId}
      />
    </div>
  );
}
