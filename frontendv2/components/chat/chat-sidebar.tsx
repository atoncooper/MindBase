"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pencil, Trash2, MessageSquare, Search, X, ChevronDown, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatSessionSummary } from "./types";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface ChatSidebarProps {
  sessions: ChatSessionSummary[];
  activeSessionId?: string;
  onSessionSelect: (sessionId: string) => void;
  /** New chat; an optional academic project id binds the new session to it. */
  onNewChat: (academicProjectId?: string) => void;
  /** Research projects offered in the new-chat picker (empty = picker hidden). */
  researchProjects?: Array<{ id: string; title: string }>;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

// Relative-time formatter (zh-CN) - keeps the sidebar self-contained.
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

// Highlight matching text in session title
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) {
    return <>{text}</>;
  }

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-foreground rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

interface SessionGroup {
  label: string;
  items: ChatSessionSummary[];
}

function groupSessionsByDate(sessions: ChatSessionSummary[]): SessionGroup[] {
  const today: ChatSessionSummary[] = [];
  const yesterday: ChatSessionSummary[] = [];
  const lastWeek: ChatSessionSummary[] = [];
  const earlier: ChatSessionSummary[] = [];

  const now = new Date();
  const todayStr = now.toDateString();
  const yesterdayStr = new Date(now.getTime() - 86400000).toDateString();

  sessions.forEach((session) => {
    const date = new Date(session.lastMessageAt).toDateString();
    if (date === todayStr) today.push(session);
    else if (date === yesterdayStr) yesterday.push(session);
    else {
      const daysDiff = Math.floor((now.getTime() - new Date(session.lastMessageAt).getTime()) / 86400000);
      if (daysDiff <= 7) lastWeek.push(session);
      else earlier.push(session);
    }
  });

  return [
    { label: "今天", items: today },
    { label: "昨天", items: yesterday },
    { label: "上周", items: lastWeek },
    { label: "更早", items: earlier },
  ].filter((g) => g.items.length > 0);
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  onSessionSelect,
  onNewChat,
  researchProjects = [],
  onDeleteSession,
  onRenameSession,
  isOpen,
  onClose,
}: ChatSidebarProps) {
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ChatSessionSummary | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // New-chat picker: plain chat vs. binding a research project (会话级持久化).
  const [newChatOpen, setNewChatOpen] = useState(false);
  const newChatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newChatOpen) return;
    const onDocPointerDown = (event: MouseEvent) => {
      if (newChatRef.current && !newChatRef.current.contains(event.target as Node)) {
        setNewChatOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointerDown);
    return () => document.removeEventListener("mousedown", onDocPointerDown);
  }, [newChatOpen]);

  // Filter sessions based on search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase().trim();
    return sessions.filter((session) =>
      session.title.toLowerCase().includes(query)
    );
  }, [sessions, searchQuery]);

  const grouped = groupSessionsByDate(filteredSessions);

  const handleStartEdit = (session: ChatSessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveEdit = (sessionId: string) => {
    if (editTitle.trim()) onRenameSession(sessionId, editTitle.trim());
    setEditingId(null);
  };

  return (
    <>
      {/* Mobile scrim */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-30 bg-black/20 backdrop-blur-[2px] md:hidden"
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      <aside
        className={cn(
          "flex flex-col bg-surface",
          // mobile: overlay drawer
          "absolute inset-y-0 left-0 z-40 transition-transform duration-300",
          // desktop: in-flow, collapsible by width
          "md:relative md:z-auto md:transition-[width] md:duration-300",
          isOpen
            ? "translate-x-0 md:w-72"
            : "-translate-x-full md:w-0 md:translate-x-0 md:overflow-hidden"
        )}
        aria-label="历史会话"
        aria-hidden={!isOpen || undefined}
      >
        <div className="flex h-full w-72 shrink-0 flex-col">
          {/* New chat CTA: 直接开普通对话；右侧箭头可选择绑定一个科研项目 */}
          <div className="p-3">
            <div ref={newChatRef} className="relative">
              <div className="flex items-stretch overflow-hidden rounded-full border border-border-subtle bg-surface">
                <button
                  type="button"
                  onClick={() => onNewChat()}
                  className="flex flex-1 items-center gap-2 px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-border-subtle/40"
                >
                  <Plus className="h-4 w-4 text-accent" aria-hidden="true" />
                  <span>开启新对话</span>
                  <kbd className="ml-auto rounded bg-border-subtle px-1.5 py-0.5 font-sans text-[10px] text-tertiary">
                    ⌘N
                  </kbd>
                </button>
                {researchProjects.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setNewChatOpen((open) => !open)}
                    aria-haspopup="menu"
                    aria-expanded={newChatOpen}
                    aria-label="选择科研项目并开启新对话"
                    className="grid w-9 place-items-center border-l border-border-subtle text-tertiary transition-colors hover:bg-border-subtle/40 hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", newChatOpen && "rotate-180")}
                      aria-hidden="true"
                    />
                  </button>
                )}
              </div>

              <AnimatePresence>
                {newChatOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15 }}
                    role="menu"
                    aria-label="新建对话选项"
                    className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-lg"
                  >
                    <div className="px-3 py-2 text-[11px] font-medium text-tertiary">选择对话类型</div>
                    <button
                      type="button"
                      role="menuitem"
                      autoFocus
                      onClick={() => {
                        setNewChatOpen(false);
                        onNewChat();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-border-subtle/60"
                    >
                      <MessageSquare className="h-4 w-4 text-tertiary" aria-hidden="true" />
                      普通对话
                    </button>
                    <div className="border-t border-border-subtle px-3 pb-1 pt-2 text-[11px] font-medium text-tertiary">
                      绑定科研项目
                    </div>
                    <div className="max-h-60 overflow-y-auto pb-1">
                      {researchProjects.map((project) => (
                        <button
                          key={project.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setNewChatOpen(false);
                            onNewChat(project.id);
                          }}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-border-subtle/60"
                        >
                          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                          <span className="min-w-0 truncate">{project.title}</span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Search box - Google style */}
          <div className="px-3 pb-2">
            <div className="relative flex items-center">
              <Search className="absolute left-3 h-4 w-4 text-tertiary pointer-events-none" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索会话"
                className={cn(
                  "w-full rounded-lg border border-border-subtle bg-surface py-2 pl-9 pr-8 text-[13px] text-foreground placeholder:text-tertiary",
                  "transition-colors focus:border-border focus:outline-none focus:ring-1 focus:ring-border",
                  searchQuery && "border-border"
                )}
                aria-label="搜索会话"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 grid h-5 w-5 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                  aria-label="清除搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {grouped.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[12px] text-tertiary">
                {searchQuery ? (
                  <>
                    <Search className="h-5 w-5 opacity-50" aria-hidden="true" />
                    <span>无匹配会话</span>
                  </>
                ) : (
                  <>
                    <MessageSquare className="h-5 w-5 opacity-50" aria-hidden="true" />
                    <span>暂无历史会话</span>
                  </>
                )}
              </div>
            ) : (
              grouped.map((group) => (
                <section key={group.label} className="mb-3">
                  <div className="px-2.5 py-1.5 text-[11px] font-medium text-tertiary">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map((session) => {
                      const isActive = session.id === activeSessionId;
                      const isEditing = editingId === session.id;
                      return (
                        <div
                          key={session.id}
                          className={cn(
                            "group relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors",
                            isActive ? "bg-accent-soft" : "hover:bg-border-subtle/60"
                          )}
                          onClick={() => !isEditing && onSessionSelect(session.id)}
                          onMouseEnter={() => setHoveredSession(session.id)}
                          onMouseLeave={() => setHoveredSession(null)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) =>
                            e.key === "Enter" && !isEditing && onSessionSelect(session.id)
                          }
                          aria-current={isActive ? "true" : undefined}
                          aria-label={`会话：${session.title}${isActive ? "（当前）" : ""}`}
                        >
                          {isEditing ? (
                            <input
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onBlur={() => handleSaveEdit(session.id)}
                              onKeyDown={(e) => e.key === "Enter" && handleSaveEdit(session.id)}
                              autoFocus
                              className="w-full rounded-md border border-accent bg-surface px-1.5 py-0.5 text-[13px] text-foreground focus:outline-none"
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`重命名会话：${session.title}`}
                            />
                          ) : (
                            <>
                              <div className="min-w-0 flex-1">
                                <div
                                  className={cn(
                                    "flex min-w-0 items-center gap-1 text-[13px] leading-snug",
                                    isActive ? "font-medium text-accent" : "text-foreground/90"
                                  )}
                                >
                                  {session.academicProjectId && (
                                    <FlaskConical
                                      className="h-3 w-3 shrink-0 text-accent"
                                      aria-label="已绑定科研项目"
                                    />
                                  )}
                                  <span className="truncate">
                                    <HighlightText text={session.title} query={searchQuery} />
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[11px] text-tertiary">
                                  {formatRelative(session.lastMessageAt)}
                                </div>
                              </div>

                              <div
                                className={cn(
                                  "flex shrink-0 items-center gap-0.5 transition-opacity",
                                  hoveredSession === session.id || isActive
                                    ? "opacity-100"
                                    : "opacity-0"
                                )}
                                role="group"
                                aria-label="会话操作"
                              >
                                <button
                                  type="button"
                                  onClick={(e) => handleStartEdit(session, e)}
                                  className="grid h-6 w-6 place-items-center rounded-md text-tertiary transition-colors hover:bg-border hover:text-foreground"
                                  aria-label={`重命名：${session.title}`}
                                >
                                  <Pencil className="h-3 w-3" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPendingDelete(session);
                                  }}
                                  className="grid h-6 w-6 place-items-center rounded-md text-tertiary transition-colors hover:bg-border hover:text-danger"
                                  aria-label={`删除：${session.title}`}
                                >
                                  <Trash2 className="h-3 w-3" aria-hidden="true" />
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
        </div>
      </aside>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话？"
        message={
          pendingDelete
            ? `「${pendingDelete.title}」及其所有消息将被永久删除，无法恢复。`
            : undefined
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (pendingDelete) onDeleteSession(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
