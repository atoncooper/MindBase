"use client";

import { useState, useRef, useEffect } from "react";
import { Send, StopCircle, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  hideDisclaimer?: boolean;
}

// Gemini-style chat input — refined editorial direction.
// Single rounded card that grows with content up to MAX_HEIGHT, then scrolls.
const MIN_HEIGHT = 44;
const MAX_HEIGHT = 360;

export default function ChatInput({
  onSend,
  disabled = false,
  isStreaming = false,
  onStop,
  placeholder = "问我任何关于你收藏的视频…",
  hideDisclaimer = false,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize: reset to auto first so scrollHeight reflects content,
  // then clamp between MIN and MAX. Beyond MAX the textarea scrolls internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.max(MIN_HEIGHT, Math.min(el.scrollHeight, MAX_HEIGHT));
    el.style.height = `${next}px`;
  }, [input]);

  const canSend = input.trim().length > 0 && !disabled;

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input-root" role="form" aria-label="聊天输入框">
      <div
        className={`chat-input-card ${canSend ? "is-ready" : ""} ${
          isStreaming ? "is-streaming" : ""
        }`}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="chat-input-textarea"
          style={{ minHeight: `${MIN_HEIGHT}px`, maxHeight: `${MAX_HEIGHT}px` }}
          aria-label="聊天消息输入"
          aria-disabled={disabled}
        />

        {/* Send / Stop button */}
        <div className="chat-input-action">
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="chat-input-stop"
              aria-label="停止生成"
            >
              <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="chat-input-send"
              aria-label="发送消息"
            >
              <Send className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {!hideDisclaimer && (
        <div className="chat-input-hint" aria-live="polite">
          <span className="chat-input-hint-keys">
            <kbd>⏎</kbd> 发送
            <kbd>⇧ ⏎</kbd> 换行
          </span>
          <span className="chat-input-hint-disclaimer">
            AI 可能出错，重要信息请核实
          </span>
        </div>
      )}
    </div>
  );
}
