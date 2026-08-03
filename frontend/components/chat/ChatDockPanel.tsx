"use client";

import { useState, useEffect, useRef } from "react";
import ChatContent from "./ChatContent";
import { chatApi, type ChatMessage as ApiChatMessage } from "@/lib/api";
import { useDockContext } from "@/lib/dock-context";
import { streamChat, type ChatSource, type ChatArtifact } from "@/lib/chat-stream";
import type { ChatMessageData } from "./types";

interface ChatDockPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

// Map backend ChatMessage → local ChatMessageData
function toUIMessage(m: ApiChatMessage): ChatMessageData {
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

export default function ChatDockPanel({ isOpen, onClose }: ChatDockPanelProps) {
  const ctx = useDockContext();
  const activeChatSessionId = ctx.activeChatSessionId;

  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // rAF throttling for streaming chunks: coalesce per-token setMessages into
  // at most one update per animation frame to avoid React reconciliation storms.
  const streamContentRef = useRef<{ id: string; content: string } | null>(null);
  const streamRafRef = useRef<number | null>(null);

  // isOpen/onClose are handled by the FloatingPanel wrapper; keep the
  // prop signature for the dock registry contract but no-op here.
  void isOpen;
  void onClose;

  // Load history when active session changes — this is the fix for
  // "can't load history" in the chat dock panel.
  useEffect(() => {
    if (!activeChatSessionId) {
      setMessages([]);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setIsLoadingHistory(true);
    setLoadError(null);
    // Clear immediately so switching sessions doesn't show stale messages.
    setMessages([]);

    (async () => {
      try {
        const res = await chatApi.getHistory(activeChatSessionId);
        if (cancelled) return;
        setMessages(res.messages.map(toUIMessage));
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "加载历史消息失败";
        setLoadError(msg);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeChatSessionId]);

  const handleSend = async (userMessage: string) => {
    if (!activeChatSessionId) {
      setLoadError("当前没有活动会话，请先在「历史会话」中创建或选择一个");
      return;
    }

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now() + 1}`;
    const timestamp = new Date().toISOString();

    setMessages((prev) => [
      ...prev,
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
    ]);

    setIsStreaming(true);

    try {
      const stream = await chatApi.askStream({
        question: userMessage,
        chat_session_id: activeChatSessionId,
      });

      await streamChat(stream, {
        onChunk: (accumulated) => {
          // Coalesce per-token updates into one setMessages per animation frame.
          streamContentRef.current = { id: assistantMsgId, content: accumulated };
          if (streamRafRef.current == null) {
            streamRafRef.current = requestAnimationFrame(() => {
              streamRafRef.current = null;
              const pending = streamContentRef.current;
              streamContentRef.current = null;
              if (!pending) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pending.id ? { ...m, content: pending.content } : m
                )
              );
            });
          }
        },
        onSources: (sources: ChatSource[]) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, sources } : m
            )
          );
        },
        onArtifact: (artifact: ChatArtifact) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsgId) return m;
              const existing = m.artifacts ?? [];
              // Dedup by url/name so a retried run_code doesn't double-render.
              const key = artifact.url || artifact.name;
              if (key && existing.some((a) => (a.url || a.name) === key)) {
                return m;
              }
              return { ...m, artifacts: [...existing, artifact] };
            })
          );
        },
        onRoute: (agent) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, agent } : m
            )
          );
        },
        onReset: () => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: "" } : m
            )
          );
        },
        onStep: (step) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsgId) return m;
              const existing = m.reasoningSteps ?? [];
              const idx = existing.findIndex((r) => r.step === step.step);
              let next;
              if (idx >= 0) {
                // Merge: tool_start provides query, tool_end provides sources.
                next = [...existing];
                next[idx] = {
                  ...next[idx],
                  action: step.action || next[idx].action,
                  query: step.query || next[idx].query,
                  reasoning: step.reasoning || next[idx].reasoning,
                  sources: step.sources?.length ? step.sources : next[idx].sources,
                };
              } else {
                next = [
                  ...existing,
                  {
                    step: step.step,
                    action: step.action,
                    query: step.query,
                    reasoning: step.reasoning,
                    sources: step.sources ?? [],
                  },
                ];
              }
              return { ...m, reasoningSteps: next };
            })
          );
        },
        onError: (message) => {
          if (streamRafRef.current != null) {
            cancelAnimationFrame(streamRafRef.current);
            streamRafRef.current = null;
          }
          streamContentRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, status: "failed", error: message }
                : m
            )
          );
        },
        onComplete: () => {
          // Flush any pending rAF chunk before marking complete.
          if (streamRafRef.current != null) {
            cancelAnimationFrame(streamRafRef.current);
            streamRafRef.current = null;
          }
          const pending = streamContentRef.current;
          streamContentRef.current = null;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsgId) return m;
              const content =
                pending && pending.id === assistantMsgId
                  ? pending.content
                  : m.content;
              return m.status === "pending"
                ? { ...m, content, status: "completed" }
                : { ...m, content };
            })
          );
        },
      });

      // Notify sidebar to refresh (backend may auto-generate title)
      ctx.refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, status: "failed", error: message }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  const handleStop = () => {
    setIsStreaming(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.status === "pending" ? { ...m, status: "completed" } : m
      )
    );
  };

  // Surface load error as a failed assistant message so it renders inline.
  const displayMessages: ChatMessageData[] =
    loadError && messages.length === 0
      ? [
          {
            id: "load-err",
            role: "assistant",
            content: "",
            status: "failed",
            error: loadError,
            timestamp: new Date().toISOString(),
          },
        ]
      : messages;

  return (
    <ChatContent
      messages={displayMessages}
      isStreaming={isStreaming || isLoadingHistory}
      onSend={handleSend}
      onStop={handleStop}
      onSuggestionClick={handleSend}
      maxWidth={768}
      inputMaxWidth={614}
      hideDisclaimer
      className="h-full"
    />
  );
}
