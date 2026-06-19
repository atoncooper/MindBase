"use client";

import { Menu, Sparkles, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatHeaderProps {
  onMenuClick?: () => void;
  onClearChat?: () => void;
  title?: string;
  hasMessages?: boolean;
}

export default function ChatHeader({
  onMenuClick,
  onClearChat,
  title = "BiliRag",
  hasMessages = false,
}: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-[var(--gemini-surface)]/95 backdrop-blur-sm border-b border-[var(--gemini-border-subtle)]">
      {/* 左侧：菜单按钮 + 标题 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden rounded-full hover:bg-[var(--gemini-surface-variant)]"
          onClick={onMenuClick}
        >
          <Menu className="w-5 h-5 text-[var(--gemini-text-secondary)]" />
        </Button>

        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--gemini-primary)] to-[#9c27b0] flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <h1 className="text-lg font-medium text-[var(--gemini-text-primary)]">{title}</h1>
        </div>
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex items-center gap-1">
        {hasMessages && (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full hover:bg-[var(--gemini-surface-variant)]"
            onClick={onClearChat}
            title="清空对话"
          >
            <Trash2 className="w-5 h-5 text-[var(--gemini-text-secondary)]" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full hover:bg-[var(--gemini-surface-variant)]"
          title="设置"
        >
          <Settings className="w-5 h-5 text-[var(--gemini-text-secondary)]" />
        </Button>
      </div>
    </header>
  );
}
