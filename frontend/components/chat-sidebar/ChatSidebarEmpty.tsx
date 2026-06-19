"use client";

import { MessageSquarePlus, ArrowUp } from "lucide-react";

interface ChatSidebarEmptyProps {
  onCreateSession: () => void;
  isCreating?: boolean;
}

export function ChatSidebarEmpty({
  onCreateSession,
  isCreating,
}: ChatSidebarEmptyProps) {
  // The header already renders the primary "新建对话" CTA, so this empty
  // state only guides the user toward it — no duplicate button here.
  void onCreateSession;
  void isCreating;

  return (
    <div className="sidebar-empty">
      <div className="sidebar-empty-icon">
        <MessageSquarePlus className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="sidebar-empty-title">还没有历史对话</p>
        <p className="sidebar-empty-hint">
          点击上方
          <ArrowUp className="inline mx-1 size-3 align-middle" />
          按钮开启新对话
        </p>
      </div>
    </div>
  );
}
