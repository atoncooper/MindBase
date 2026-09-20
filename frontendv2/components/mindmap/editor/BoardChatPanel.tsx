/**
 * 板聊对话框：针对当前板子的对话（后端 board agent）。
 *
 * 屏幕正中的浮动对话框，按住标题栏可拖拽。复用全局聊天的 SSE 管线
 * （chatApi.askStream + streamChat），请求携带 board_uuid，后端据此直路由
 * 到 board agent。会话懒创建（首条消息前），独立于全局聊天页的会话列表。
 */

import { useEffect, useRef, useState } from "react";
import { chatApi } from "@/lib/api";
import { streamChat } from "@/lib/chat-stream";
import { toErrorMessage } from "./errmsg";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export function BoardChatPanel({
  boardUuid,
  boardTitle,
  onClose,
}: {
  boardUuid: string;
  boardTitle: string;
  onClose: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const streamingRef = useRef(false);
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

  // 懒创建板聊专用会话（与全局聊天页的会话互不相干）。
  useEffect(() => {
    let cancelled = false;
    chatApi
      .createSession(`板聊：${boardTitle}`.slice(0, 60))
      .then((session) => {
        if (!cancelled) sessionRef.current = session.chat_session_id;
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err));
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [boardTitle]);

  // 消息或流式状态变化时滚到底部。
  useEffect(() => {
    const body = bodyRef.current;
    if (body !== null) body.scrollTop = body.scrollHeight;
  }, [messages, streaming]);

  function send(): void {
    const question = input.trim();
    if (question === "" || streaming) return;
    if (sessionRef.current === null) {
      setError("会话尚未就绪，请稍候再试");
      return;
    }

    setError(null);
    setInput("");
    const history = [...messagesRef.current, { role: "user" as const, text: question }];
    setMessages([...history, { role: "assistant", text: "" }]);
    setStreaming(true);
    streamingRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const assistantIndex = history.length;

    void chatApi
      .askStream({ question, chat_session_id: sessionRef.current, board_uuid: boardUuid }, controller.signal)
      .then((stream) =>
        streamChat(stream, {
          onChunk: (accumulated) => {
            setMessages((prev) => {
              const next = [...prev];
              next[assistantIndex] = { role: "assistant", text: accumulated };
              return next;
            });
          },
          onError: (message) => {
            setMessages((prev) => {
              const next = [...prev];
              next[assistantIndex] = {
                role: "assistant",
                text: prev[assistantIndex]?.text || `生成失败：${message}`,
              };
              return next;
            });
            setError(message);
          },
        })
      )
      .catch((err) => {
        setError(toErrorMessage(err));
        setMessages((prev) => {
          const next = [...prev];
          next[assistantIndex] = { role: "assistant", text: `生成失败：${toErrorMessage(err)}` };
          return next;
        });
      })
      .finally(() => {
        setStreaming(false);
        streamingRef.current = false;
        abortRef.current = null;
      });
  }

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
        <span className="mm-boardchat-title">板聊 · {boardTitle || "未命名板子"}</span>
        <button type="button" className="mm-boardchat-close" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="mm-boardchat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="mm-boardchat-empty">
            询问关于这块板子的任何问题：解释结构、补充内容、修改建议……
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`mm-boardchat-msg mm-boardchat-msg--${message.role}`}>
            {message.text === "" && streaming ? "…" : message.text}
          </div>
        ))}
      </div>
      {error !== null && <div className="mm-boardchat-error">{error}</div>}
      <div className="mm-boardchat-inputrow">
        <textarea
          className="mm-boardchat-input"
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          rows={2}
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
        <button
          type="button"
          className="mm-boardchat-send"
          disabled={streaming || input.trim() === ""}
          onClick={send}
        >
          {streaming ? "…" : "发送"}
        </button>
      </div>
    </div>
  );
}
