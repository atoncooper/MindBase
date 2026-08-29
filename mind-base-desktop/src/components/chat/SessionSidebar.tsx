/**
 * 会话历史侧栏：展开态（新建按钮 + 会话列表）⇄ 收起态（56px 窄脊）。
 *
 * 窄脊与左侧导航栏同宽形成布局节奏；保留「新建」与每个会话的**首字方块**
 * 作为快速切换器（hover 出原生 tooltip 显示全名），active 方块反色。
 * 全部交互经回调上抛，由 ChatView 持有状态。
 *
 * 动画：两个状态渲染在**同一个常驻 <aside>** 里（双内容块按 collapsed 类名
 * 切换显隐），宽度/内边距的变化因此能走 CSS transition 平滑展开收起——
 * 若做成两棵子树早退切换，元素重挂载会导致过渡失效。
 */

import { useState } from "react";

/** Sidebar session shape (subset of lib/chat ChatSessionRow). */
export interface SidebarSession {
  chatSessionId: string;
  title: string;
  updatedAt: number;
}

/** Epoch seconds → 相对时间标签。 */
function relativeTime(epochSecs: number): string {
  const deltaMs = Date.now() - epochSecs * 1000;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}

/** Collapse-toggle glyph (panel with left pane). */
function PanelIcon({ folded }: { folded: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M9.5 5v14" />
      {folded && <path d="m15 10-2 2 2 2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Plus glyph for the collapsed new-chat button. */
function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M12 5v14" strokeLinecap="round" />
      <path d="M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

/** 首字方块内容：取标题首个字形；空标题回退为「新」。 */
function initialOf(title: string): string {
  const first = title.trim().charAt(0);
  return first === "" ? "新" : first.toUpperCase();
}

interface SessionSidebarProps {
  sessions: SidebarSession[];
  /** Null = draft state (新对话 not yet created). */
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onSummarize: (sessionId: string) => void;
}

function SessionSidebar({
  sessions,
  activeId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSummarize,
}: SessionSidebarProps): React.JSX.Element {
  // Which row is showing its inline rename input (empty = none).
  const [editingId, setEditingId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  function startRename(session: SidebarSession): void {
    setEditingId(session.chatSessionId);
    setDraftTitle(session.title);
  }

  function commitRename(): void {
    const trimmed = draftTitle.trim();
    if (editingId !== "" && trimmed !== "" && trimmed !== sessions.find((s) => s.chatSessionId === editingId)?.title) {
      onRename(editingId, trimmed);
    }
    setEditingId("");
  }

  /* 两个状态共用同一个 <aside>（见组件注释），内容块按 collapsed 切换。 */
  return (
    <aside className={collapsed ? "chat-sidebar chat-sidebar--collapsed" : "chat-sidebar"}>
      {/* 收起态：窄脊（toggle + 新建 + 首字方块切换器） */}
      <div className="chat-sidebar__spine" aria-hidden={!collapsed}>
        <button
          type="button"
          className="icon-button spine-btn"
          aria-label="展开历史"
          title="展开历史 (Ctrl+B)"
          tabIndex={collapsed ? 0 : -1}
          onClick={onToggleCollapsed}
        >
          <PanelIcon folded={false} />
        </button>
        <button
          type="button"
          className="icon-button spine-btn"
          aria-label="新建对话"
          title="新建对话"
          tabIndex={collapsed ? 0 : -1}
          onClick={onCreate}
        >
          <PlusIcon />
        </button>

        <span className="spine-divider" aria-hidden="true" />

        <ul className="spine-list">
          {sessions.map((session) => {
            const active = session.chatSessionId === activeId;
            return (
              <li key={session.chatSessionId}>
                <button
                  type="button"
                  className={active ? "spine-item spine-item--active" : "spine-item"}
                  title={`${session.title}${session.updatedAt > 0 ? `\n${relativeTime(session.updatedAt)}` : ""}`}
                  tabIndex={collapsed ? 0 : -1}
                  onClick={() => onSelect(session.chatSessionId)}
                >
                  {initialOf(session.title)}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 展开态 */}
      <div className="chat-sidebar__body" aria-hidden={collapsed}>
        <div className="chat-sidebar__top">
          <button
            type="button"
            className="icon-button"
            aria-label="折叠历史"
            title="折叠历史 (Ctrl+B)"
            tabIndex={collapsed ? -1 : 0}
            onClick={onToggleCollapsed}
          >
            <PanelIcon folded />
          </button>
          <button
            type="button"
            className="button button--primary chat-sidebar__new"
            tabIndex={collapsed ? -1 : 0}
            onClick={onCreate}
          >
            ＋ 新建对话
          </button>
        </div>

        {sessions.length === 0 ? (
          <p className="chat-sidebar__empty">开始你的第一段对话</p>
        ) : (
          <ul className="session-list">
            {sessions.map((session) => {
              const active = session.chatSessionId === activeId;
              const editing = session.chatSessionId === editingId;
              return (
                <li key={session.chatSessionId} className={active ? "session-item session-item--active" : "session-item"}>
                  {editing ? (
                    <input
                      type="text"
                      className="cfg-input session-item__input"
                      value={draftTitle}
                      autoFocus
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setEditingId("");
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="session-item__body"
                        title={session.title}
                        tabIndex={collapsed ? -1 : 0}
                        onClick={() => onSelect(session.chatSessionId)}
                      >
                        <span className="session-item__title">{session.title}</span>
                        <span className="session-item__time">{relativeTime(session.updatedAt)}</span>
                      </button>
                      <span className="session-item__actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="总结会话"
                          title="生成会话总结（可保存为笔记）"
                          tabIndex={collapsed ? -1 : 0}
                          onClick={() => onSummarize(session.chatSessionId)}
                        >
                          ≡
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="重命名"
                          tabIndex={collapsed ? -1 : 0}
                          onClick={() => startRename(session)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="删除会话"
                          tabIndex={collapsed ? -1 : 0}
                          onClick={() => {
                            if (window.confirm(`删除会话「${session.title}」及其全部消息？`)) {
                              onDelete(session.chatSessionId);
                            }
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

export default SessionSidebar;
