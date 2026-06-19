"use client";

import { useState, useEffect } from "react";
import ChatContent from "./ChatContent";
import { chatApi, type ChatMessage as ApiChatMessage } from "@/lib/api";
import { useDockContext } from "@/lib/dock-context";
import { streamChat, type ChatSource } from "@/lib/chat-stream";
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
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: accumulated } : m
            )
          );
        },
        onSources: (sources: ChatSource[]) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, sources } : m
            )
          );
        },
        onError: (message) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, status: "failed", error: message }
                : m
            )
          );
        },
        onComplete: () => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId && m.status === "pending"
                ? { ...m, status: "completed" }
                : m
            )
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
