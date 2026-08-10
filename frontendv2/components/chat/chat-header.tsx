"use client";

import Link from "next/link";
import { Home, PanelLeft, Trash2 } from "lucide-react";

interface ChatHeaderProps {
  title: string;
  hasMessages: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onClearChat: () => void;
}

export function ChatHeader({
  title,
  hasMessages,
  sidebarOpen,
  onToggleSidebar,
  onClearChat,
}: ChatHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-3">
      <div className="flex min-w-0 items-center gap-1">
        <Link
          href="/"
          className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
          title="返回首页"
          aria-label="返回首页"
        >
          <Home className="h-[18px] w-[18px]" />
        </Link>

        <button
          type="button"
          onClick={onToggleSidebar}
          className={`grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-border-subtle ${
            sidebarOpen ? "text-foreground" : "text-secondary"
          }`}
          aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          aria-expanded={sidebarOpen}
        >
          <PanelLeft className="h-[18px] w-[18px]" />
        </button>

        <h1 className="ml-1 truncate text-[14px] font-medium text-foreground">{title}</h1>
      </div>

      <div className="flex items-center gap-0.5">
        {hasMessages && (
          <button
            type="button"
            onClick={onClearChat}
            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-danger"
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
