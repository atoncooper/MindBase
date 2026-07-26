"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { notesApi, type NoteDetail } from "@/lib/api";
import { saveDraft, getDraft, clearDraft } from "./draft-store";
import { Share2, Trash2 } from "lucide-react";
// TypeScript may not have a module declaration for CSS imports in this project.
// @ts-ignore: allow importing CSS in TSX
import "./notes.css";

interface NoteEditorProps {
    note: NoteDetail;
    onChanged: () => void;
    onShare: () => void;
    onDelete: () => void;
}

type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

// Editor view modes: write-only (distraction-free), split (default), read-only.
type ViewMode = "write" | "split" | "read";

const STATUS_LABEL: Record<SaveStatus, string> = {
    idle: "",
    saving: "保存中",
    saved: "已保存",
    error: "保存失败 · 草稿已留",
    conflict: "冲突 · 该笔记已在别处修改",
};

// ─── keyboard helpers ────────────────────────────────────────────────

/** Wrap selected text (or insert placeholder) with prefix + suffix. */
function wrapSelection(
    textarea: HTMLTextAreaElement,
    prefix: string,
    suffix: string,
    placeholder: string,
): string {
    const { value, selectionStart: s, selectionEnd: e } = textarea;
    const selected = value.slice(s, e) || placeholder;
    return value.slice(0, s) + prefix + selected + suffix + value.slice(e);
}

/** After wrapping, compute where to place the cursor. */
function wrapCursor(
    s: number,
    e: number,
    prefix: string,
    hasSelection: boolean,
): [number, number] {
    if (hasSelection) {
        return [s + prefix.length, e + prefix.length];
    }
    // cursor sits inside the placeholder
    const mid = s + prefix.length;
    return [mid, mid];
}

/** Get the text of the current line (up to cursor). */
function currentLineBeforeCursor(value: string, cursor: number): string {
    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
    return value.slice(lineStart, cursor);
}

/** Regex that matches leading whitespace + optional list marker. */
const LIST_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+)(.*)$/;
const TASK_RE = /^(\s*)([-*+]\s+\[[ xX]\]\s+)(.*)$/;

export default function NoteEditor({ note, onChanged, onShare, onDelete }: NoteEditorProps) {
    const [title, setTitle] = useState(note.title);
    const [content, setContent] = useState(note.contentMd);
    const [status, setStatus] = useState<SaveStatus>("idle");
    const [draftPrompt, setDraftPrompt] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>("split");

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const serverUpdatedAtRef = useRef<string | null>(note.updatedAt);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── keyboard handler: shortcuts + auto-indent ──────────────────
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            const ta = e.currentTarget;
            const mod = e.ctrlKey || e.metaKey;

            // Ctrl+S — trigger immediate save (prevent browser save-dialog)
            if (mod && e.key === "s") {
                e.preventDefault();
                // force a save by bumping content then restoring
                setStatus("saving");
                return;
            }

            // ── markdown formatting shortcuts ─────────────────────
            if (mod) {
                const s = ta.selectionStart;
                const e2 = ta.selectionEnd;
                const hasSelection = s !== e2;
                let prefix = "";
                let suffix = "";
                let placeholder = "";

                switch (e.key) {
                    case "b": // bold
                        prefix = "**"; suffix = "**"; placeholder = "粗体";
                        break;
                    case "i": // italic
                        prefix = "*"; suffix = "*"; placeholder = "斜体";
                        break;
                    case "k": // link
                        prefix = "["; suffix = "](url)"; placeholder = "链接文字";
                        break;
                    case "`": // inline code
                        prefix = "`"; suffix = "`"; placeholder = "code";
                        break;
                    default:
                        return; // not a shortcut we handle
                }

                e.preventDefault();
                const newValue = wrapSelection(ta, prefix, suffix, placeholder);
                const [ns, ne] = wrapCursor(s, e2, prefix, hasSelection);
                setContent(newValue);
                // restore cursor after React re-render
                requestAnimationFrame(() => {
                    ta.selectionStart = ns;
                    ta.selectionEnd = ne;
                });
                return;
            }

            // Ctrl+Shift+K — code block (check after mod-only block)
            if (mod && e.shiftKey && e.key === "K") {
                e.preventDefault();
                const s = ta.selectionStart;
                const e2 = ta.selectionEnd;
                const hasSelection = s !== e2;
                const newValue = wrapSelection(ta, "```\n", "\n```", "code");
                const [ns, ne] = wrapCursor(s, e2, "```\n", hasSelection);
                setContent(newValue);
                requestAnimationFrame(() => {
                    ta.selectionStart = ns;
                    ta.selectionEnd = ne;
                });
                return;
            }

            // ── Tab / Shift+Tab — indent / outdent ─────────────────
            if (e.key === "Tab") {
                e.preventDefault();
                const s = ta.selectionStart;
                const e2 = ta.selectionEnd;
                const value = ta.value;

                if (e.shiftKey) {
                    // outdent: remove up to 2 leading spaces from each selected line
                    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
                    const lineEnd = value.indexOf("\n", e2 - 1);
                    const selEnd = lineEnd === -1 ? value.length : lineEnd;
                    const lines = value.slice(lineStart, selEnd).split("\n");
                    const outdented = lines
                        .map((l) => l.replace(/^ {1,2}/, ""))
                        .join("\n");
                    const newValue =
                        value.slice(0, lineStart) + outdented + value.slice(selEnd);
                    const removed = lines.reduce(
                        (acc, l) => acc + (l.match(/^ {1,2}/)?.[0]?.length ?? 0),
                        0,
                    );
                    setContent(newValue);
                    requestAnimationFrame(() => {
                        ta.selectionStart = Math.max(lineStart, s - Math.min(2, removed));
                        ta.selectionEnd = Math.max(lineStart, e2 - removed);
                    });
                } else if (s !== e2) {
                    // indent selected lines
                    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
                    const lineEnd = value.indexOf("\n", e2 - 1);
                    const selEnd = lineEnd === -1 ? value.length : lineEnd;
                    const lines = value.slice(lineStart, selEnd).split("\n");
                    const indented = lines.map((l) => "  " + l).join("\n");
                    const newValue =
                        value.slice(0, lineStart) + indented + value.slice(selEnd);
                    setContent(newValue);
                    requestAnimationFrame(() => {
                        ta.selectionStart = s + 2;
                        ta.selectionEnd = e2 + 2 * lines.length;
                    });
                } else {
                    // insert 2 spaces at cursor
                    const newValue =
                        value.slice(0, s) + "  " + value.slice(e2);
                    setContent(newValue);
                    requestAnimationFrame(() => {
                        ta.selectionStart = ta.selectionEnd = s + 2;
                    });
                }
                return;
            }

            // ── Enter — auto-indent + continue lists ───────────────
            if (e.key === "Enter") {
                e.preventDefault();
                const s = ta.selectionStart;
                const e2 = ta.selectionEnd;
                const value = ta.value;

                const before = currentLineBeforeCursor(value, s);
                const afterCursor = value.slice(e2);
                const afterLineMatch = afterCursor.match(/^(.*)/);
                const afterLine = afterLineMatch?.[1] ?? "";

                // Check for task list
                const taskMatch = before.match(TASK_RE);
                if (taskMatch) {
                    const indent = taskMatch[1];
                    const afterText = taskMatch[3];
                    if (afterText.trim() === "") {
                        // Empty task item — outdent (remove the marker)
                        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
                        const newValue =
                            value.slice(0, lineStart) + indent + "\n" + value.slice(s);
                        setContent(newValue);
                        requestAnimationFrame(() => {
                            const pos = lineStart + indent.length;
                            ta.selectionStart = ta.selectionEnd = pos;
                        });
                    } else {
                        // Continue task list
                        const marker = taskMatch[2].replace(/\[[xX]\]/, "[ ]");
                        const insertion = "\n" + indent + marker;
                        const newValue = value.slice(0, s) + insertion + value.slice(e2);
                        setContent(newValue);
                        requestAnimationFrame(() => {
                            const pos = s + insertion.length;
                            ta.selectionStart = ta.selectionEnd = pos;
                        });
                    }
                    return;
                }

                // Check for regular list
                const listMatch = before.match(LIST_RE);
                if (listMatch) {
                    const indent = listMatch[1];
                    const marker = listMatch[2];
                    const afterText = listMatch[3];
                    if (afterText.trim() === "") {
                        // Empty list item — outdent
                        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
                        const newValue =
                            value.slice(0, lineStart) + indent + "\n" + value.slice(s);
                        setContent(newValue);
                        requestAnimationFrame(() => {
                            const pos = lineStart + indent.length;
                            ta.selectionStart = ta.selectionEnd = pos;
                        });
                    } else {
                        // Auto-number ordered lists
                        let nextMarker = marker;
                        const numMatch = marker.match(/^(\d+)([.)])/);
                        if (numMatch) {
                            nextMarker = String(Number(numMatch[1]) + 1) + numMatch[2] + " ";
                        }
                        const insertion = "\n" + indent + nextMarker;
                        const newValue = value.slice(0, s) + insertion + value.slice(e2);
                        setContent(newValue);
                        requestAnimationFrame(() => {
                            const pos = s + insertion.length;
                            ta.selectionStart = ta.selectionEnd = pos;
                        });
                    }
                    return;
                }

                // No list — just preserve indentation
                const indentMatch = before.match(/^(\s*)/);
                const indent = indentMatch?.[1] ?? "";
                const insertion = "\n" + indent;
                const newValue = value.slice(0, s) + insertion + value.slice(e2);
                setContent(newValue);
                requestAnimationFrame(() => {
                    const pos = s + insertion.length;
                    ta.selectionStart = ta.selectionEnd = pos;
                });
            }
        },
        [],
    );

    // Reset internal state ONLY when switching to a different note. We
    // deliberately do NOT depend on note.contentMd / note.updatedAt here:
    // re-running on every auto-save round-trip would clobber in-flight
    // edits - the server returns the pre-debounce content, which would
    // overwrite keystrokes the user typed during the await. Server-version
    // sync is handled by the separate effect below.
    useEffect(() => {
        setTitle(note.title);
        setContent(note.contentMd);
        serverUpdatedAtRef.current = note.updatedAt;
        setStatus("idle");

        getDraft(note.uuid).then((draft) => {
            if (!draft) return;
            const serverMs = new Date(note.updatedAt).getTime();
            if (Number.isFinite(serverMs) && draft.savedAt > serverMs) {
                setDraftPrompt(true);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note.uuid]);

    // Keep serverUpdatedAtRef in sync when the server advances updated_at
    // (after our own auto-save, or an external edit). Crucially, do NOT
    // touch local title/content here - that would overwrite unsaved
    // keystrokes typed during the save round-trip.
    useEffect(() => {
        serverUpdatedAtRef.current = note.updatedAt;
    }, [note.uuid, note.updatedAt]);

    const isClean = title === note.title && content === note.contentMd;

    // Debounced auto-save — 1500ms after last keystroke.
    useEffect(() => {
        if (isClean) return;

        setStatus("saving");
        saveDraft(note.uuid, {
            contentMd: content,
            title,
            savedAt: Date.now(),
        });

        const timer = setTimeout(async () => {
            try {
                const updated = await notesApi.update(
                    note.uuid,
                    { title, contentMd: content },
                    serverUpdatedAtRef.current ?? undefined,
                );
                serverUpdatedAtRef.current = updated.updatedAt;
                setStatus("saved");
                await clearDraft(note.uuid);
                onChanged();
                // Clear "saved" pill after 2.5s.
                if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
                savedTimerRef.current = setTimeout(() => setStatus("idle"), 2500);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "";
                if (msg.includes("409") || msg.includes("conflict")) {
                    setStatus("conflict");
                } else {
                    setStatus("error");
                }
            }
        }, 1500);

        return () => clearTimeout(timer);
    }, [title, content, note.uuid, note.title, note.contentMd, isClean, onChanged]);

    // Latest edits live in a ref so the unload/visibility listeners
    // (registered once) always read current values — no stale closure.
    const latestRef = useRef({ title, content, noteTitle: note.title, noteContent: note.contentMd });
    useEffect(() => {
        latestRef.current = { title, content, noteTitle: note.title, noteContent: note.contentMd };
    }, [title, content, note.title, note.contentMd]);

    // Persist draft on tab-hide / unmount. No fire-and-forget PATCH —
    // fetch on unload is unreliable and sendBeacon cannot set custom
    // headers (If-Match). IndexedDB draft is the recovery path.
    useEffect(() => {
        const flush = () => {
            const { title: t, content: c, noteTitle, noteContent } = latestRef.current;
            if (t === noteTitle && c === noteContent) return;
            saveDraft(note.uuid, {
                contentMd: c,
                title: t,
                savedAt: Date.now(),
            });
        };

        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("beforeunload", flush);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("beforeunload", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [note.uuid]);

    const statusClass = `note-status-pill is-${status}`;
    const showStatus = status !== "idle" || !isClean;

    const recoverDraft = async () => {
        const draft = await getDraft(note.uuid);
        if (draft) {
            if (draft.title) setTitle(draft.title);
            setContent(draft.contentMd);
        }
        setDraftPrompt(false);
    };

    const discardDraft = async () => {
        await clearDraft(note.uuid);
        setDraftPrompt(false);
    };

    const wordCount = useMemo(() => {
        if (!content) return 0;
        // Strip markdown noise for a rough char count.
        const stripped = content
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`]*`/g, "")
            .replace(/[#*_>\-\[\]()!]/g, "");
        return stripped.trim().length;
    }, [content]);

    // Rough reading-time estimate — ~350 CJK chars/min. Only shown when >0.
    const readingMinutes = useMemo(
        () => (wordCount > 0 ? Math.max(1, Math.round(wordCount / 350)) : 0),
        [wordCount],
    );

    // Defensive: backend may send invalid date / missing revision count.
    const updatedAtMs = new Date(note.updatedAt).getTime();
    const dateText = Number.isFinite(updatedAtMs)
        ? new Date(note.updatedAt).toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "long",
              day: "numeric",
          })
        : "暂无日期";
    const revisionText = `${note.revisionCount ?? 0} 次修订`;

    return (
        <div className="notes-scope flex flex-col h-full note-fade-in">
            {/* Title + status */}
            <div
                className="px-10 pt-7 pb-5 grid grid-cols-[1fr_2fr_1fr] items-start gap-3"
                style={{ borderBottom: "1px solid var(--note-line-soft)" }}
            >
                <span />
                <div className="min-w-0 flex flex-col items-center">
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="无标题"
                        className="note-title-input"
                        style={{ textAlign: "center" }}
                    />
                    <div
                        className="flex items-center gap-3 mt-3.5"
                        style={{ color: "var(--note-ink-faint)" }}
                    >
                        <span className="note-eyebrow">{dateText}</span>
                        <span className="note-meta-sep">·</span>
                        <span className="note-eyebrow">{wordCount} 字</span>
                        {readingMinutes > 0 && (
                            <>
                                <span className="note-meta-sep">·</span>
                                <span className="note-eyebrow">约 {readingMinutes} 分钟</span>
                            </>
                        )}
                        <span className="note-meta-sep">·</span>
                        <span className="note-eyebrow">{revisionText}</span>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-2 justify-self-end">
                    {showStatus && (
                        <span className={statusClass}>
                            <span className="dot" />
                            {STATUS_LABEL[status]}
                        </span>
                    )}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onShare}
                            className="note-btn is-ghost"
                            title="分享"
                            aria-label="分享"
                        >
                            <Share2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            type="button"
                            onClick={onDelete}
                            className="note-btn is-ghost is-danger"
                            title="删除"
                            aria-label="删除"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <span style={{ width: 1, height: 18, background: "var(--note-line)", flexShrink: 0 }} />
                        <div className="note-seg" role="group" aria-label="视图模式">
                            <button
                                type="button"
                                className={`note-seg-btn ${viewMode === "write" ? "is-active" : ""}`}
                                onClick={() => setViewMode("write")}
                                title="仅写作"
                            >
                                写作
                            </button>
                            <button
                                type="button"
                                className={`note-seg-btn ${viewMode === "split" ? "is-active" : ""}`}
                                onClick={() => setViewMode("split")}
                                title="分屏"
                            >
                                分屏
                            </button>
                            <button
                                type="button"
                                className={`note-seg-btn ${viewMode === "read" ? "is-active" : ""}`}
                                onClick={() => setViewMode("read")}
                                title="仅阅读"
                            >
                                阅读
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {draftPrompt && (
                <div
                    className="flex items-center justify-between gap-3 px-8 py-2.5 text-sm"
                    style={{
                        background: "var(--note-accent-soft)",
                        color: "var(--note-accent-ink)",
                        borderBottom: "1px solid var(--note-line-soft)",
                    }}
                >
                    <span style={{ fontFamily: "var(--note-sans)", fontSize: 13 }}>
                        检测到未保存的草稿，是否恢复？
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={recoverDraft}
                            className="note-btn is-primary"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                        >
                            恢复草稿
                        </button>
                        <button
                            onClick={discardDraft}
                            className="note-btn"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                        >
                            丢弃
                        </button>
                    </div>
                </div>
            )}

            {/* Edit grid — write / split / read modes */}
            <div className={`flex-1 grid min-h-0 note-edit-grid is-${viewMode}`}>
                <div
                    className="overflow-auto flex flex-col note-pane-write"
                    style={{
                        borderRight: "1px solid var(--note-line)",
                        background: "var(--note-paper)",
                    }}
                >
                    <div className="note-content-wrap flex flex-col flex-1 min-h-0 py-6">
                        <textarea
                            ref={textareaRef}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="从此处开始落笔…"
                            className="note-textarea"
                            spellCheck={false}
                        />
                    </div>
                    {/* Keyboard shortcut hints */}
                    <div className="note-kbd-hints">
                        <span><kbd>Ctrl+B</kbd> 粗体</span>
                        <span><kbd>Ctrl+I</kbd> 斜体</span>
                        <span><kbd>Ctrl+K</kbd> 链接</span>
                        <span><kbd>Tab</kbd> 缩进</span>
                        <span><kbd>Enter</kbd> 续列表</span>
                    </div>
                </div>
                <div
                    className="overflow-auto flex flex-col note-preview note-pane-preview"
                    style={{ background: "var(--note-paper-elev)" }}
                >
                    <div className="note-content-wrap py-6">
                        {content ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {content}
                            </ReactMarkdown>
                        ) : (
                            <p
                                style={{
                                    color: "var(--note-ink-faint)",
                                    fontFamily: "var(--note-sans)",
                                    fontSize: 14,
                                    lineHeight: 1.6,
                                }}
                            >
                                编辑 Markdown 内容后，此处将实时展示预览效果
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
