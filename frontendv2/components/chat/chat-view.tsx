"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChatSidebar } from "./chat-sidebar";
import { ChatHeader } from "./chat-header";
import ChatMessage from "./chat-message";
import { ChatInput } from "./chat-input";
import { ChatEmpty } from "./chat-empty";
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

export function ChatView() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // ---- Auto-scroll to newest message (rAF-throttled; auto during stream) ----
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
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

  // ---- Core: stream a question into the active session ----
  const streamQuestion = useCallback(
    async (question: string, assistantMsgId: string) => {
      if (!activeSessionId) return;
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const stream = await chatApi.askStream(
          {
            question,
            chat_session_id: activeSessionId,
          },
          controller.signal
        );

        await streamChat(
          stream,
          {
            onChunk: (accumulated) => {
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: accumulated } : m
                ),
              }));
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
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: "" } : m
                ),
              }));
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
              updateActiveSession((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, status: "failed", error: message } : m
                ),
              }));
            },
            onComplete: () => {
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
      }
    },
    [activeSessionId, updateActiveSession, refreshSessions]
  );

  // ---- Send a message ----
  const handleSend = useCallback(
    (userMessage: string) => {
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

      void streamQuestion(userMessage, assistantMsgId);
    },
    [activeSessionId, updateActiveSession, streamQuestion]
  );

  // ---- Regenerate: re-ask the last user question, replacing the assistant msg ----
  const handleRegenerate = useCallback(
    (assistantMsgId: string) => {
      if (!activeSessionId || isStreaming) return;
      const sess = sessions.find((s) => s.id === activeSessionId);
      if (!sess) return;
      const idx = sess.messages.findIndex((m) => m.id === assistantMsgId);
      if (idx <= 0) return;
      const prevUser = [...sess.messages.slice(0, idx)].reverse().find((m) => m.role === "user");
      if (!prevUser) return;

      updateActiveSession((s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: "", status: "pending", error: undefined, sources: undefined, reasoningSteps: undefined, artifacts: undefined }
            : m
        ),
      }));
      void streamQuestion(prevUser.content, assistantMsgId);
    },
    [activeSessionId, isStreaming, sessions, updateActiveSession, streamQuestion]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    updateActiveSession((s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.status === "pending" ? { ...m, status: "completed" } : m
      ),
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
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "创建会话失败");
    }
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
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
        />

        {loadError && (
          <div className="border-b border-danger/10 bg-danger/5 px-4 py-2 text-[12px] text-danger">
            {loadError}
          </div>
        )}

        {/* Messages scroll area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <ChatEmpty onSuggestionClick={handleSend} />
          ) : (
            <div className="mx-auto max-w-[768px] space-y-5 px-5 py-6">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  sources={message.sources}
                  artifacts={message.artifacts}
                  reasoningSteps={message.reasoningSteps}
                  agent={message.agent}
                  status={message.status}
                  error={message.error}
                  timestamp={message.timestamp}
                  onRegenerate={
                    message.role === "assistant" && message.status === "completed"
                      ? () => handleRegenerate(message.id)
                      : undefined
                  }
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
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
            />
          </div>
        </div>
      </main>
    </div>
  );
}
