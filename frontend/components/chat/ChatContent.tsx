"use client";

import { useEffect, useRef } from "react";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import EmptyState from "./EmptyState";
import type { ChatMessageData } from "./types";

interface ChatContentProps {
  messages: ChatMessageData[];
  isStreaming: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
  onSuggestionClick?: (suggestion: string) => void;
  // Max width in px for messages area.
  // Default 768 (Gemini full-page style). Use 576 for narrower dock contexts.
  maxWidth?: number;
  // Max width in px for the input area. Defaults to maxWidth.
  // Set smaller to make the input narrower than the messages (Gemini style).
  inputMaxWidth?: number;
  hideDisclaimer?: boolean;
  className?: string;
}

export default function ChatContent({
  messages,
  isStreaming,
  onSend,
  onStop,
  onSuggestionClick,
  maxWidth = 768,
  inputMaxWidth,
  hideDisclaimer = false,
  className = "",
}: ChatContentProps) {
  // Input area is narrower than the messages area by default (Gemini style).
  const effectiveInputWidth = inputMaxWidth ?? maxWidth;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Centered content wrapper for messages.
  // Inline style guarantees the max-width is applied regardless of Tailwind
  // class generation quirks.
  const messagesStyle: React.CSSProperties = {
    width: "100%",
    maxWidth,
    marginLeft: "auto",
    marginRight: "auto",
  };

  // Centered content wrapper for input — can be narrower than messages.
  const inputStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: effectiveInputWidth,
    marginLeft: "auto",
    marginRight: "auto",
  };

  return (
    <div className={`panel-inner chat-content ${className}`}>
      {/* 消息滚动区域 — panel-body 自带 flex:1 + overflow-y:auto */}
      <div className="panel-body">
        <div style={messagesStyle}>
          {messages.length === 0 ? (
            <EmptyState onSuggestionClick={onSuggestionClick ?? onSend} />
          ) : (
            <div className="chat-window">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  sources={message.sources}
                  reasoningSteps={message.reasoningSteps}
                  agent={message.agent}
                  status={message.status}
                  error={message.error}
                  timestamp={message.timestamp}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* 底部输入区域 - 比消息区略窄居中（Gemini 风格） */}
      <div className="panel-footer">
        <div style={inputStyle}>
          <ChatInput
            onSend={onSend}
            disabled={isStreaming}
            isStreaming={isStreaming}
            onStop={onStop}
            hideDisclaimer={hideDisclaimer}
            placeholder="输入你的问题..."
          />
        </div>
      </div>
    </div>
  );
}
