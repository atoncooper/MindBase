"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";

interface ChatSession {
  id: string;
  title: string;
  lastMessageAt: string;
  isActive?: boolean;
}

interface ChatHistorySidebarProps {
  sessions?: ChatSession[];
  activeSessionId?: string;
  onSessionSelect?: (sessionId: string) => void;
  onNewChat?: () => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newTitle: string) => void;
  isOpen?: boolean;
  onClose?: () => void;
}

// Relative-time formatter (zh-CN) — keeps the sidebar self-contained.
function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

const groupSessionsByDate = (sessions: ChatSession[]) => {
  const today: ChatSession[] = [];
  const yesterday: ChatSession[] = [];
  const lastWeek: ChatSession[] = [];
  const earlier: ChatSession[] = [];

  const now = new Date();
  const todayStr = now.toDateString();
  const yesterdayStr = new Date(now.getTime() - 86400000).toDateString();

  sessions.forEach((session) => {
    const date = new Date(session.lastMessageAt).toDateString();
    if (date === todayStr) {
      today.push(session);
    } else if (date === yesterdayStr) {
      yesterday.push(session);
    } else {
      const daysDiff = Math.floor((now.getTime() - new Date(session.lastMessageAt).getTime()) / 86400000);
      if (daysDiff <= 7) {
        lastWeek.push(session);
      } else {
        earlier.push(session);
      }
    }
  });

  return [
    { label: "今天", items: today },
    { label: "昨天", items: yesterday },
    { label: "上周", items: lastWeek },
    { label: "更早", items: earlier },
  ].filter((g) => g.items.length > 0);
};

export default function ChatHistorySidebar({
  sessions = [
    { id: "1", title: "如何学习 React?", lastMessageAt: new Date().toISOString() },
    { id: "2", title: "总结机器学习视频要点", lastMessageAt: new Date(Date.now() - 86400000).toISOString() },
    { id: "3", title: "前端学习路径规划", lastMessageAt: new Date(Date.now() - 86400000 * 3).toISOString() },
  ],
  activeSessionId,
  onSessionSelect,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  isOpen = true,
  onClose,
}: ChatHistorySidebarProps) {
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const grouped = groupSessionsByDate(sessions);

  const handleStartEdit = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveEdit = (sessionId: string) => {
    if (editTitle.trim()) {
      onRenameSession?.(sessionId, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <>
      {isOpen && (
        <div
          className="chat-sidebar-scrim"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`chat-sidebar ${isOpen ? "is-open" : ""}`}
        aria-label="历史会话"
      >
        {/* Header */}
        <div className="chat-sidebar-header">
          <div className="chat-sidebar-brand">
            <span className="chat-sidebar-brand-dot" aria-hidden="true" />
            <span className="chat-sidebar-brand-label">会话档案</span>
          </div>
          <button
            type="button"
            className="chat-sidebar-close"
            onClick={onClose}
            aria-label="关闭侧边栏"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* New chat CTA */}
        <div className="chat-sidebar-cta">
          <button
            type="button"
            onClick={onNewChat}
            className="chat-sidebar-new"
          >
            <span className="chat-sidebar-new-icon" aria-hidden="true">
              <Plus className="w-4 h-4" />
            </span>
            <span className="chat-sidebar-new-text">开启新对话</span>
            <kbd className="chat-sidebar-new-kbd">⌘N</kbd>
          </button>
        </div>

        {/* Session list */}
        <div className="chat-sidebar-list">
          {grouped.length === 0 ? (
            <div className="chat-sidebar-empty">暂无历史会话</div>
          ) : (
            grouped.map((group) => (
              <section key={group.label} className="chat-sidebar-group">
                <div className="chat-sidebar-group-label">
                  <span>{group.label}</span>
                  <span className="chat-sidebar-group-count">{group.items.length}</span>
                </div>
                <div className="chat-sidebar-group-items">
                  {group.items.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const isEditing = editingId === session.id;
                    return (
                      <div
                        key={session.id}
                        className={`chat-session ${isActive ? "is-active" : ""}`}
                        onClick={() => !isEditing && onSessionSelect?.(session.id)}
                        onMouseEnter={() => setHoveredSession(session.id)}
                        onMouseLeave={() => setHoveredSession(null)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) =>
                          e.key === "Enter" && !isEditing && onSessionSelect?.(session.id)
                        }
                        aria-selected={isActive}
                        aria-label={`会话：${session.title}${isActive ? "（当前）" : ""}`}
                      >
                        <span className="chat-session-rail" aria-hidden="true" />

                        {isEditing ? (
                          <div className="chat-session-edit">
                            <input
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onBlur={() => handleSaveEdit(session.id)}
                              onKeyDown={(e) =>
                                e.key === "Enter" && handleSaveEdit(session.id)
                              }
                              autoFocus
                              className="chat-session-edit-input"
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`重命名会话：${session.title}`}
                            />
                          </div>
                        ) : (
                          <>
                            <div className="chat-session-body">
                              <div className="chat-session-title">{session.title}</div>
                              <div className="chat-session-meta">
                                {formatRelative(session.lastMessageAt)}
                              </div>
                            </div>

                            <div
                              className={`chat-session-actions ${
                                hoveredSession === session.id ? "is-visible" : ""
                              }`}
                              role="group"
                              aria-label="会话操作"
                            >
                              <button
                                type="button"
                                onClick={(e) => handleStartEdit(session, e)}
                                className="chat-session-action"
                                aria-label={`重命名：${session.title}`}
                              >
                                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteSession?.(session.id);
                                }}
                                className="chat-session-action chat-session-action-danger"
                                aria-label={`删除：${session.title}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="chat-sidebar-footer">
          <div className="chat-sidebar-footer-brand">BiliRag</div>
          <div className="chat-sidebar-footer-meta">收藏夹知识库 · v1.0</div>
        </div>
      </aside>
    </>
  );
}
