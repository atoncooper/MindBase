/**
 * 笔记编辑面板 —— 编辑 / 预览双模式。
 *
 * 编辑：整篇纯文本 textarea。受控但从不干预选区，浏览器原生 Ctrl+Z 撤销
 * 与中文输入法组词都天然可用；Markdown 源码即所见。
 * 预览：react-markdown 渲染（GFM 表格/任务列表 + 单换行成 <br>）。
 *
 * 保存仍由 NotesView 编排（800ms 防抖 + 乐观并发），本组件纯展示与上抛。
 */

import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { NoteAnchor, RevisionMeta } from "../../lib/notes";
import { MarkdownContent } from "../chat/MarkdownContent";

export type EditorMode = "edit" | "preview";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  conflict: "冲突 · 该笔记已在别处被修改",
  error: "保存失败",
};

// ---------------------------------------------------------------------------
// 编辑快捷键的纯函数工具：输入全文 + 选区，输出新全文 + 新选区。
// ---------------------------------------------------------------------------

interface EditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/** 用成对记号包裹选区；若选区两侧已是该记号则解除（切换语义）。 */
function wrapSelection(full: string, s: number, e: number, token: string): EditResult {
  const before = full.slice(Math.max(0, s - token.length), s);
  const after = full.slice(e, e + token.length);
  if (before === token && after === token && e > s) {
    return {
      text: full.slice(0, s - token.length) + full.slice(s, e) + full.slice(e + token.length),
      selStart: s - token.length,
      selEnd: e - token.length,
    };
  }
  const inner = full.slice(s, e);
  return {
    text: `${full.slice(0, s)}${token}${inner}${token}${full.slice(e)}`,
    selStart: s + token.length,
    selEnd: s + token.length + inner.length,
  };
}

/** 插入链接：有选区时选区作链接文字，否则放占位文字；url 部分被选中待改。 */
function insertLink(full: string, s: number, e: number): EditResult {
  const label = full.slice(s, e);
  const snippet = `[${label === "" ? "链接文字" : label}](url)`;
  const urlStart = s + 1 + (label === "" ? "链接文字".length : label.length) + 3;
  return { text: full.slice(0, s) + snippet + full.slice(e), selStart: urlStart, selEnd: urlStart + 3 };
}

/** 行级前缀开关（标题/引用/列表）：对选区覆盖的每一行生效。 */
function toggleLinePrefix(full: string, s: number, e: number, kind: "h1" | "h2" | "h3" | "quote" | "ul"): EditResult {
  const lineStart = full.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
  const nlAt = full.indexOf("\n", e);
  const lineEnd = nlAt === -1 ? full.length : nlAt;
  const lines = full.slice(lineStart, lineEnd).split("\n");
  const marker =
    kind === "quote" ? "> "
    : kind === "ul" ? "- "
    : "#".repeat(kind === "h1" ? 1 : kind === "h2" ? 2 : 3) + " ";
  let toggledOff = false;
  let allOn = true;
  for (const line of lines) {
    const has = line.startsWith(marker)
      || (kind !== "quote" && kind !== "ul" && new RegExp(`^${marker.replace(" ", "\\s+")}`).test(line));
    if (!has) allOn = false;
  }
  // 全部已带该前缀 → 视为关闭；否则全部开启。
  if (allOn) toggledOff = true;
  const next = lines.map((line) => {
    const indentMatch = line.match(/^\s*/);
    const indent = indentMatch?.[0] ?? "";
    const body = line.slice(indent.length);
    if (toggledOff) {
      const stripped =
        body.startsWith(marker) ? body.slice(marker.length)
        : kind === "quote" && body.startsWith(">") ? body.slice(1).replace(/^ /, "")
        : kind === "h1" || kind === "h2" || kind === "h3"
          ? body.replace(/^#{1,6}[ \t]+/, "")
          : body;
      return indent + stripped;
    }
    // 已是其它级别标题 → 先剥掉再套用目标级别。
    const base =
      kind === "h1" || kind === "h2" || kind === "h3"
        ? body.replace(/^#{1,6}[ \t]+/, "")
        : body;
    return `${indent}${marker}${base}`;
  });
  const blockText = next.join("\n");
  return {
    text: full.slice(0, lineStart) + blockText + full.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + blockText.length,
  };
}

/** Tab 缩进 / Shift+Tab 反缩进（两空格步进，作用于所选行）。 */
function indentLines(full: string, s: number, e: number, outdent: boolean): EditResult {
  const lineStart = full.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
  const nlAt = full.indexOf("\n", e);
  const lineEnd = nlAt === -1 ? full.length : nlAt;
  const lines = full.slice(lineStart, lineEnd).split("\n").map((line) =>
    outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`,
  );
  const blockText = lines.join("\n");
  return {
    text: full.slice(0, lineStart) + blockText + full.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + blockText.length,
  };
}

/**
 * 回车的列表续写：
 * - 列表项内回车 → 换行并复制标记（有序列表自增）；
 * - 光标后剩余内容跟随到新行；
 * - 空列表项回车 → 清除标记退出列表。
 * 返回 null 表示交给浏览器默认换行行为。
 */
function listEnter(full: string, caret: number): EditResult | null {
  const lineStart = full.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const nlAt = full.indexOf("\n", caret);
  const lineEnd = nlAt === -1 ? full.length : nlAt;
  const line = full.slice(lineStart, lineEnd);
  const m = line.match(/^(\s*)([-*]|\d+\.)([ \t]+)(.*)$/);
  if (m === null) return null;
  if (m[4].trim() === "") {
    // 空项退出列表：抹掉「标记 + 空格」本身。
    const cutFrom = lineStart + m[1].length;
    return {
      text: full.slice(0, cutFrom) + full.slice(cutFrom + m[2].length + m[3].length),
      selStart: cutFrom,
      selEnd: cutFrom,
    };
  }
  const marker = /\d/.test(m[2]) ? `${Number.parseInt(m[2], 10) + 1}.` : m[2];
  const insert = `\n${m[1]}${marker}${m[3]}`;
  return {
    text: full.slice(0, caret) + insert + full.slice(caret),
    selStart: caret + insert.length,
    selEnd: caret + insert.length,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NoteEditorPaneProps {
  title: string;
  content: string;
  mode: EditorMode;
  saveStatus: SaveStatus;
  anchors: NoteAnchor[];
  pinned: boolean;
  revisionsOpen: boolean;
  revisions: RevisionMeta[] | null;
  /** Ctrl+S 立即落盘（由父组件执行防抖合并后的保存）。 */
  onSaveNow: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onAddAnchor: (input: string) => void;
  onDeleteAnchor: (anchorId: string) => void;
  onToggleRevisions: () => void;
  onRestoreRevision: (revisionId: string) => void;
}

function NoteEditorPane({
  title,
  content,
  mode,
  saveStatus,
  anchors,
  pinned,
  revisionsOpen,
  revisions,
  onSaveNow,
  onTitleChange,
  onContentChange,
  onModeChange,
  onTogglePin,
  onDelete,
  onAddAnchor,
  onDeleteAnchor,
  onToggleRevisions,
  onRestoreRevision,
}: NoteEditorPaneProps): React.JSX.Element {
  const [anchorInput, setAnchorInput] = useState("");
  const [anchorError, setAnchorError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const charCount = content.replace(/\s/g, "").length;

  /** 统一入口：算出新文本 → 上抛 → 在下一帧恢复选区（等受控 DOM 提交）。 */
  function applyEdit(result: EditResult): void {
    onContentChange(result.text);
    window.setTimeout(() => {
      bodyRef.current?.setSelectionRange(result.selStart, result.selEnd);
    }, 0);
  }

  /** 编辑区按键路由。输入法组合期间一律放行。 */
  function handleBodyKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    const el = event.currentTarget;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSaveNow();
      return;
    }
    if (mod && event.key.toLowerCase() === "e") {
      event.preventDefault();
      onModeChange(mode === "edit" ? "preview" : "edit");
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      applyEdit(wrapSelection(el.value, s, e, "**"));
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "i") {
      event.preventDefault();
      applyEdit(wrapSelection(el.value, s, e, "*"));
      return;
    }
    if (mod && event.key === "`") {
      event.preventDefault();
      applyEdit(wrapSelection(el.value, s, e, "`"));
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      applyEdit(wrapSelection(el.value, s, e, "~~"));
      return;
    }
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      applyEdit(insertLink(el.value, s, e));
      return;
    }
    if (mod && !event.shiftKey && (event.key === "1" || event.key === "2" || event.key === "3")) {
      event.preventDefault();
      applyEdit(
        toggleLinePrefix(el.value, s, e, `h${event.key}` as "h1" | "h2" | "h3"),
      );
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "q") {
      event.preventDefault();
      applyEdit(toggleLinePrefix(el.value, s, e, "quote"));
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      applyEdit(toggleLinePrefix(el.value, s, e, "ul"));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const result = listEnter(el.value, s);
      if (result !== null) {
        event.preventDefault();
        applyEdit(result);
      }
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applyEdit(indentLines(el.value, s, e, event.shiftKey));
    }
  }

  return (
    <section className="note-editor typ-editor">
      <div className="note-editor__toolbar">
        <input
          type="text"
          className="note-editor__title"
          placeholder="笔记标题"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
        />
        <span className={saveStatus === "conflict" || saveStatus === "error" ? "status status--error" : "status"}>
          {STATUS_LABEL[saveStatus]}
        </span>
        <button type="button" className="icon-button" aria-label={pinned ? "取消置顶" : "置顶"} onClick={onTogglePin}>
          {pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          className={revisionsOpen ? "tab tab--active note-editor__mode" : "tab note-editor__mode"}
          onClick={onToggleRevisions}
        >
          历史
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="删除笔记"
          onClick={() => window.confirm("删除这篇笔记？历史修订将一并删除。") && onDelete()}
        >
          ✕
        </button>
      </div>

      <div className="typ-toolbar" role="group" aria-label="视图模式">
        <div className="note-editor__modes">
          {(
            [
              ["edit", "编辑"],
              ["preview", "预览"],
            ] as ReadonlyArray<[EditorMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "note-mode note-mode--active" : "note-mode"}
              onClick={() => onModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Anchors strip */}
      <div className="anchors">
        <span className="anchors__label">锚点</span>
        {anchors.map((anchor) => (
          <span key={anchor.id} className="ws-chip anchor-chip">
            <button type="button" onClick={() => void openUrl(anchor.url)} title={anchor.url}>
              【{anchor.label}】
              {anchor.seconds > 0
                ? ` ${Math.floor(anchor.seconds / 60)}:${String(anchor.seconds % 60).padStart(2, "0")}`
                : ""}
            </button>
            <button
              type="button"
              className="anchor-chip__del"
              aria-label="删除锚点"
              onClick={() => onDeleteAnchor(anchor.id)}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          type="text"
          className="cfg-input anchors__input"
          placeholder="粘贴 B 站链接或 BV 号，回车添加"
          value={anchorInput}
          onChange={(event) => setAnchorInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const trimmed = anchorInput.trim();
              if (trimmed === "") return;
              setAnchorError("");
              onAddAnchor(trimmed);
              setAnchorInput("");
            }
          }}
        />
        <button type="button" className="button" onClick={() => {
          const trimmed = anchorInput.trim();
          if (trimmed === "") return;
          setAnchorError("");
          onAddAnchor(trimmed);
          setAnchorInput("");
        }}>
          添加
        </button>
      </div>
      {anchorError !== "" && <p className="error-text">{anchorError}</p>}

      {/* ── Body ── */}
      {mode === "edit" ? (
        <>
          <textarea
            ref={bodyRef}
            className="typ-scroll note-editor__body"
            placeholder="用 Markdown 记录…"
            value={content}
            spellCheck={false}
            onChange={(event) => onContentChange(event.target.value)}
            onKeyDown={handleBodyKeyDown}
          />
          <p className="typ-hint" aria-hidden="true">
            <span><b className="kbd">Ctrl+B</b>粗体</span>
            <span><b className="kbd">Ctrl+I</b>斜体</span>
            <span><b className="kbd">Ctrl+`</b>代码</span>
            <span><b className="kbd">Ctrl+K</b>链接</span>
            <span><b className="kbd">Ctrl+⇧+X</b>删除线</span>
            <span><b className="kbd">Ctrl+1/2/3</b>标题</span>
            <span><b className="kbd">Ctrl+⇧+Q</b>引用</span>
            <span><b className="kbd">Ctrl+⇧+L</b>列表</span>
            <span><b className="kbd">Tab</b>缩进</span>
            <span><b className="kbd">Ctrl+E</b>预览</span>
            <span><b className="kbd">Ctrl+S</b>保存</span>
          </p>
        </>
      ) : (
        <div className="typ-scroll">
          <article className="typ-paper markdown-body">
            {content.trim() === "" ? (
              <p className="hint-text">（暂无内容）</p>
            ) : (
              <MarkdownContent content={content} />
            )}
          </article>
        </div>
      )}

      {/* Status strip */}
      <div className="typ-status">
        <span>{charCount} 字</span>
        <span className="typ-status__right">{STATUS_LABEL[saveStatus]}</span>
      </div>

      {/* Revisions drawer */}
      {revisionsOpen && (
        <aside className="revisions">
          <p className="revisions__head">历史修订（最近 20 条）</p>
          {revisions === null && <p className="hint-text">加载中…</p>}
          {revisions !== null && revisions.length === 0 && (
            <p className="hint-text">还没有修订快照。改动超过 30% 且距上次快照 10 分钟以上会自动留存。</p>
          )}
          {revisions !== null &&
            revisions.map((revision) => (
              <div key={revision.id} className="revisions__item">
                <span className="revisions__meta">
                  {new Date(revision.createdAt * 1000).toLocaleString()} · {revision.charCount} 字
                </span>
                <button type="button" className="button" onClick={() => onRestoreRevision(revision.id)}>
                  回滚到此版
                </button>
              </div>
            ))}
        </aside>
      )}
    </section>
  );
}

export default NoteEditorPane;
