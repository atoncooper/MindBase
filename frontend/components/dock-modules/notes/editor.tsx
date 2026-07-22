"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export default function NoteEditor({ note, onChanged, onShare, onDelete }: NoteEditorProps) {
    const [title, setTitle] = useState(note.title);
    const [content, setContent] = useState(note.contentMd);
    const [status, setStatus] = useState<SaveStatus>("idle");
    const [draftPrompt, setDraftPrompt] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>("split");

    const serverUpdatedAtRef = useRef<string | null>(note.updatedAt);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
                className="px-28 pt-9 pb-6 grid grid-cols-[1fr_2fr_1fr] items-start gap-3"
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
                    className="overflow-auto pl-32 pr-20 py-6 note-pane-write"
                    style={{
                        borderRight: "1px solid var(--note-line)",
                        background: "var(--note-paper)",
                    }}
                >
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="从此处开始落笔…"
                        className="note-textarea"
                        spellCheck={false}
                    />
                </div>
                <div
                    className="overflow-auto pl-28 pr-16 py-6 note-preview note-pane-preview"
                    style={{ background: "var(--note-paper-elev)" }}
                >
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
    );
}
