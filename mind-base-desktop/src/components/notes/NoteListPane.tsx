/**
 * 笔记列表栏：搜索过滤 + 置顶分组 + 条目（标题/摘要/时间）与 hover 操作。
 * 纯受控组件——选中、置顶、删除全部上抛给 NotesView 编排。
 */

import type { NoteListRow } from "../../lib/notes";

function relativeTime(epochSecs: number): string {
  const deltaMs = Date.now() - epochSecs * 1000;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}

interface NoteListPaneProps {
  notes: NoteListRow[];
  activeId: string | null;
  query: string;
  busyId: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
}

function NoteListPane({
  notes,
  activeId,
  query,
  busyId,
  onQueryChange,
  onSelect,
  onCreate,
  onTogglePin,
  onDelete,
}: NoteListPaneProps): React.JSX.Element {
  return (
    <aside className="notes-list">
      <div className="notes-list__top">
        <input
          type="text"
          className="cfg-input notes-list__search"
          placeholder="搜索标题或正文…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button type="button" className="button button--primary" onClick={onCreate}>
          ＋ 新建
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="notes-list__empty">
          {query.trim() === "" ? "还没有笔记，点「＋ 新建」开始。" : "没有匹配的笔记。"}
        </p>
      ) : (
        <ul className="notes-items">
          {notes.map((note) => {
            const active = note.id === activeId;
            return (
              <li key={note.id} className={active ? "note-item note-item--active" : "note-item"}>
                <button type="button" className="note-item__body" onClick={() => onSelect(note.id)}>
                  <span className="note-item__title">
                    {note.pinned && <span className="note-item__pin">📌</span>}
                    {note.title !== "" ? note.title : "未命名笔记"}
                  </span>
                  <span className="note-item__snippet">{note.snippet !== "" ? note.snippet : "（空）"}</span>
                  <span className="note-item__meta">
                    {relativeTime(note.updatedAt)} · {note.charCount} 字
                  </span>
                </button>
                <span className="note-item__actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={note.pinned ? "取消置顶" : "置顶"}
                    disabled={busyId === note.id}
                    title={note.pinned ? "取消置顶" : "置顶"}
                    onClick={() => onTogglePin(note.id)}
                  >
                    {note.pinned ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="删除笔记"
                    disabled={busyId === note.id}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除笔记「${note.title !== "" ? note.title : "未命名笔记"}」？历史修订将一并删除。`,
                        )
                      ) {
                        onDelete(note.id);
                      }
                    }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default NoteListPane;
