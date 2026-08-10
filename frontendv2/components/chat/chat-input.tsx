"use client";

import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  hideDisclaimer?: boolean;
}

// Apple-style chat input - a single rounded card that grows with content up to
// MAX_HEIGHT, then scrolls internally. Send button is a filled accent circle.
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 200;

export function ChatInput({
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
    <div className="w-full" role="form" aria-label="聊天输入框">
      <div
        className={`flex items-end gap-2 rounded-[22px] border bg-surface px-3 py-2 shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-colors ${
          canSend ? "border-border" : "border-border-subtle"
        } ${isStreaming ? "border-accent/40" : ""}`}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-foreground placeholder:text-tertiary focus:outline-none disabled:opacity-50"
          style={{ minHeight: `${MIN_HEIGHT}px`, maxHeight: `${MAX_HEIGHT}px` }}
          aria-label="聊天消息输入"
          aria-disabled={disabled}
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
            aria-label="停止生成"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-subtle disabled:text-tertiary"
            aria-label="发送消息"
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {!hideDisclaimer && (
        <div className="mt-1.5 flex items-center justify-center gap-3 text-[11px] text-tertiary" aria-live="polite">
          <span>
            <kbd className="font-sans">⏎</kbd> 发送 · <kbd className="font-sans">⇧ ⏎</kbd> 换行
          </span>
          <span className="text-border">·</span>
          <span>AI 可能出错，重要信息请核实</span>
        </div>
      )}
    </div>
  );
}
