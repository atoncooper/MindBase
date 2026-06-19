"use client";

import { useState, useEffect, useCallback } from "react";
import ChatContent from "./ChatContent";
import ChatHeader from "./ChatHeader";
import ChatHistorySidebar from "./ChatHistorySidebar";
import { chatApi, type ChatSession, type ChatMessage } from "@/lib/api";
import { streamChat, type ChatSource } from "@/lib/chat-stream";
import type { ChatMessageData } from "./types";

// Local UI session shape — maps backend ChatSession + holds loaded messages.
interface UISession {
  id: string; // chat_session_id from backend
  title: string;
  lastMessageAt: string;
  messages: ChatMessageData[];
  historyLoaded: boolean;
}

// Map backend ChatMessage → local ChatMessageData
function toUIMessage(m: ChatMessage): ChatMessageData {
  return {
    id: m.msg_id,
    role: m.role === "system" ? "assistant" : m.role,
    content: m.content,
    // Backend may return null; normalize to array.
    sources: Array.isArray(m.sources) ? m.sources : undefined,
    status: m.status,
    error: m.error,
    timestamp: m.created_at,
  };
}

// Map backend ChatSession → local UISession (without messages until loaded)
function toUISession(s: ChatSession): UISession {
  return {
    id: s.chat_session_id,
    title: s.title || "新对话",
    lastMessageAt: s.last_message_at || s.updated_at || s.created_at,
    messages: [],
    historyLoaded: false,
  };
}

export default function ChatPanel() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages ?? [];

  // ---- Backend session list loading ----
  const refreshSessions = useCallback(async () => {
    setIsLoadingSessions(true);
    setLoadError(null);
    try {
      const res = await chatApi.listSessions();
      const mapped = res.sessions.map(toUISession);
      // Preserve any already-loaded messages by merging on id.
      setSessions((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        return mapped.map((s) => {
          const existing = byId.get(s.id);
          return existing ? { ...s, messages: existing.messages, historyLoaded: existing.historyLoaded } : s;
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载会话列表失败";
      setLoadError(msg);
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  // ---- On mount: load sessions, auto-create first one if empty ----
  useEffect(() => {
    (async () => {
      await refreshSessions();
      // If no sessions exist, create one. Need to read fresh state via callback form.
      let created: ChatSession | null = null;
      setSessions((prev) => {
        if (prev.length === 0) {
          // Trigger creation outside the updater (avoid setState-in-setState).
          chatApi
            .createSession()
            .then((res) => {
              created = res;
              setSessions([toUISession(res)]);
              setActiveSessionId(res.chat_session_id);
            })
            .catch((e) => {
              setLoadError(e instanceof Error ? e.message : "创建会话失败");
            });
        }
        return prev;
      });
      // Fallback: if sessions exist, activate the first.
      setSessions((prev) => {
        if (prev.length > 0 && !activeSessionId) {
          setActiveSessionId(prev[0].id);
        }
        return prev;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Load message history when active session changes ----
  useEffect(() => {
    if (!activeSessionId) return;
    const sess = sessions.find((s) => s.id === activeSessionId);
    if (!sess || sess.historyLoaded) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await chatApi.getHistory(activeSessionId);
        if (cancelled) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  messages: res.messages.map(toUIMessage),
                  historyLoaded: true,
                }
              : s
          )
        );
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "加载历史消息失败";
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId ? { ...s, historyLoaded: true, messages: [{ id: "load-err", role: "assistant", content: "", status: "failed", error: msg, timestamp: new Date().toISOString() }] } : s
          )
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, sessions]);

  const updateActiveSession = (updater: (s: UISession) => UISession) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? updater(s) : s))
    );
  };

  // ---- Send a message ----
  const handleSend = async (userMessage: string) => {
    if (!activeSessionId) return;

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now() + 1}`;
    const timestamp = new Date().toISOString();

    updateActiveSession((s) => ({
      ...s,
      lastMessageAt: timestamp,
      messages: [
        ...s.messages,
        {
          id: userMsgId,
          role: "user",
          content: userMessage,
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

    setIsStreaming(true);

    try {
      const stream = await chatApi.askStream({
        question: userMessage,
        chat_session_id: activeSessionId,
      });

      await streamChat(stream, {
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
        onError: (message) => {
          updateActiveSession((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantMsgId
                ? { ...m, status: "failed", error: message }
                : m
            ),
          }));
        },
        onComplete: () => {
          updateActiveSession((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantMsgId && m.status === "pending"
                ? { ...m, status: "completed" }
                : m
            ),
          }));
        },
      });

      // Refresh session list (title may be auto-generated by backend)
      refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      updateActiveSession((s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, status: "failed", error: message }
            : m
        ),
      }));
    } finally {
      setIsStreaming(false);
    }
  };

  const handleStop = () => {
    setIsStreaming(false);
    updateActiveSession((s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.status === "pending" ? { ...m, status: "completed" } : m
      ),
    }));
  };

  // ---- New chat: create backend session ----
  const handleNewChat = async () => {
    try {
      const res = await chatApi.createSession();
      const ui = toUISession(res);
      ui.historyLoaded = true; // empty session, no need to fetch history
      setSessions((prev) => [ui, ...prev]);
      setActiveSessionId(res.chat_session_id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "创建会话失败");
    }
  };

  const handleSessionSelect = (sessionId: string) => {
    setActiveSessionId(sessionId);
  };

  // ---- Delete: call backend, then refresh ----
  const handleDeleteSession = async (sessionId: string) => {
    if (sessions.length <= 1) return;
    try {
      await chatApi.deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const next = sessions.find((s) => s.id !== sessionId);
        setActiveSessionId(next?.id ?? null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "删除会话失败");
    }
  };

  // ---- Rename: call backend, then update local ----
  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    try {
      await chatApi.updateSession(sessionId, { title: newTitle });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "重命名会话失败");
    }
  };

  const handleClearChat = () => {
    if (!activeSessionId) return;
    // Clear local messages; backend history remains but UI resets.
    updateActiveSession((s) => ({ ...s, messages: [] }));
  };

  return (
    <div className="flex h-screen w-screen bg-[var(--gemini-surface)]">
      <ChatHistorySidebar
        sessions={
          isLoadingSessions
            ? []
            : sessions.map((s) => ({
                id: s.id,
                title: s.title,
                lastMessageAt: s.lastMessageAt,
              }))
        }
        activeSessionId={activeSessionId ?? undefined}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 flex flex-col h-full min-w-0">
        <ChatHeader
          onMenuClick={() => setSidebarOpen(true)}
          onClearChat={handleClearChat}
          title={activeSession?.title ?? "BiliRag"}
          hasMessages={messages.length > 0}
        />

        {loadError && (
          <div className="px-4 py-2 text-xs text-[var(--gemini-text-tertiary)] bg-red-500/5 border-b border-red-500/10">
            {loadError}
          </div>
        )}

        <div className="flex-1 min-h-0">
          <ChatContent
            messages={messages}
            isStreaming={isStreaming}
            onSend={handleSend}
            onStop={handleStop}
            onSuggestionClick={handleSend}
            maxWidth={768}
            inputMaxWidth={614}
          />
        </div>
      </main>
    </div>
  );
}
