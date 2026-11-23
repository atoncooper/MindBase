"use client";

import Link from "next/link";
import { Home, PanelLeft, ScrollText, Trash2 } from "lucide-react";

interface ChatHeaderProps {
  title: string;
  hasMessages: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onClearChat: () => void;
  onSummarize?: () => void;
  // Live turn in progress: show a light pulsing dot next to the title.
  isStreaming?: boolean;
}

export function ChatHeader({
  title,
  hasMessages,
  sidebarOpen,
  onToggleSidebar,
  onClearChat,
  onSummarize,
  isStreaming = false,
}: ChatHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-2 sm:h-12 sm:px-3">
      <div className="flex min-w-0 items-center gap-1">
        <Link
          href="/"
          className="grid h-9 w-9 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground sm:h-8 sm:w-8"
          title="返回首页"
          aria-label="返回首页"
        >
          <Home className="h-[18px] w-[18px]" />
        </Link>

        <button
          type="button"
          onClick={onToggleSidebar}
          className={`grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-border-subtle sm:h-8 sm:w-8 ${
            sidebarOpen ? "text-foreground" : "text-secondary"
          }`}
          aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          aria-expanded={sidebarOpen}
        >
          <PanelLeft className="h-[18px] w-[18px]" />
        </button>

        <h1 className="ml-1 truncate text-[15px] font-medium text-foreground sm:text-[14px]">{title}</h1>
        {isStreaming && (
          <span
            className="ml-1.5 inline-flex shrink-0 items-center gap-1 text-[11px] text-tertiary"
            role="status"
            aria-label="正在生成回复"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <span className="hidden sm:inline">生成中</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        {hasMessages && onSummarize && (
          <button
            type="button"
            onClick={onSummarize}
            className="grid h-9 w-9 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground sm:h-8 sm:w-8"
            title="总结会话"
            aria-label="总结会话"
          >
            <ScrollText className="h-[17px] w-[17px]" />
          </button>
        )}
        {hasMessages && (
          <button
            type="button"
            onClick={onClearChat}
            className="grid h-9 w-9 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-danger sm:h-8 sm:w-8"
            title="清空当前对话"
            aria-label="清空当前对话"
          >
            <Trash2 className="h-[17px] w-[17px]" />
          </button>
        )}
      </div>
    </header>
  );
}
