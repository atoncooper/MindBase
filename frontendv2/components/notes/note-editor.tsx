"use client";

/**
 * Note editor - textarea (write) or rendered markdown (read).
 *
 * Two modes only: write (plain textarea, left-aligned) and read (rendered
 * preview). The content column is left-aligned (mr-auto) instead of centered,
 * so writing starts from the left edge. Autosave is debounced (1.5s),
 * optimistic with If-Match concurrency, and backed by an IndexedDB draft so
 * in-flight typing survives crashes. Markdown shortcuts (Ctrl+B/I/K, list
 * continuation, tab indent) are handled in handleKeyDown.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import {
    Share2,
    Trash2,
    Eye,
    Pencil,
    Loader2,
    Check,
    AlertCircle,
    CloudOff,
    ArrowLeft,
} from "lucide-react";
import type { NoteDetail } from "@/lib/api/notes";
import { notesApi } from "@/lib/api/notes";
import { cn } from "@/lib/utils";
import { saveDraft, getDraft, clearDraft } from "./draft-store";
import { motion } from "framer-motion";

type ViewMode = "write" | "read";
type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

interface NoteEditorProps {
    note: NoteDetail;
    onChanged: () => void;
    onDelete: () => void;
    onShare: () => void;
    onBack: () => void; // mobile: back to list
}

const SAVE_DEBOUNCE_MS = 1500;

// ── helpers ────────────────────────────────────────────────────────

function wordCount(md: string): number {
    return md
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/[#>*_~\[\]()!]/g, "")
        .replace(/\s/g, "")
        .length;
}

/** Wrap (or placeholder-insert) the current textarea selection. Returns the
 * new value + next selection, or null if no change. */
function wrapSelection(
    value: string,
    start: number,
    end: number,
    before: string,
    after: string,
    placeholder: string
): { value: string; selStart: number; selEnd: number } | null {
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    const selStart = start + before.length;
    const selEnd = selStart + selected.length;
    return { value: next, selStart, selEnd };
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TASK_RE = /^(\s*)([-*+])\s+\[[ xX]\]\s+(.*)$/;

export function NoteEditor({ note, onChanged, onDelete, onShare, onBack }: NoteEditorProps) {
    const [title, setTitle] = useState(note.title);
    const [content, setContent] = useState(note.contentMd);
    const [status, setStatus] = useState<SaveStatus>("idle");
    const [viewMode, setViewMode] = useState<ViewMode>("write");
    const [draftPrompt, setDraftPrompt] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const serverUpdatedAtRef = useRef<string>(note.updatedAt);
    const latestRef = useRef({ title, content, uuid: note.uuid });

    // Keep latest title/content for beforeunload flush.
    useEffect(() => {
        latestRef.current = { title, content, uuid: note.uuid };
    }, [title, content, note.uuid]);

    // On note switch: reset local state + check for a newer draft. The resets
    // sync to the note identity (external data), not derived from render, so
    // the cascading-render rule is a false positive here.
    useEffect(() => {
        /* eslint-disable react-hooks/set-state-in-effect */
        setTitle(note.title);
        setContent(note.contentMd);
        setStatus("idle");
        serverUpdatedAtRef.current = note.updatedAt;
        setDraftPrompt(false);
        /* eslint-enable react-hooks/set-state-in-effect */
        let cancelled = false;
        void (async () => {
            const draft = await getDraft(note.uuid);
            if (cancelled || !draft) return;
            const noteTs = new Date(note.updatedAt).getTime();
            if (Number.isFinite(noteTs) && draft.savedAt > noteTs) {
                setDraftPrompt(true);
            }
        })();
        return () => {
            cancelled = true;
        };
        // Deliberately only on uuid - NOT on note.contentMd/updatedAt, so a save
        // round-trip never overwrites in-flight typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note.uuid]);

    // Sync serverUpdatedAt when the server reports a newer version (post-save),
    // without touching local title/content.
    useEffect(() => {
        serverUpdatedAtRef.current = note.updatedAt;
    }, [note.uuid, note.updatedAt]);

    // Autosave (debounced). Skips when clean vs the server snapshot.
    useEffect(() => {
        if (title === note.title && content === note.contentMd) return;
        const uuid = note.uuid;
        const timer = setTimeout(() => {
            void (async () => {
                setStatus("saving");
                await saveDraft(uuid, {
                    contentMd: content,
                    title,
                    savedAt: Date.now(),
                });
                try {
                    const updated = await notesApi.update(
                        uuid,
                        { title, contentMd: content },
                        serverUpdatedAtRef.current
                    );
                    serverUpdatedAtRef.current = updated.updatedAt;
                    setStatus("saved");
                    await clearDraft(uuid);
                    onChanged();
                    setTimeout(() => {
                        setStatus((s) => (s === "saved" ? "idle" : s));
                    }, 2500);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : "";
                    if (msg.includes("409") || msg.includes("conflict")) {
                        setStatus("conflict");
                    } else {
                        setStatus("error");
                    }
                }
            })();
        }, SAVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [title, content, note.title, note.contentMd, note.uuid, onChanged]);

    // Flush draft on tab hide / unload (fetch on unload is unreliable and
    // sendBeacon can't carry If-Match, so we only persist the draft).
    useEffect(() => {
        const flush = () => {
            const { title: t, content: c, uuid } = latestRef.current;
            void saveDraft(uuid, { contentMd: c, title: t, savedAt: Date.now() });
        };
        const onVis = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("beforeunload", flush);
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("beforeunload", flush);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, []);

    // Auto-resize textarea to content.
    useLayoutEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
    }, [content, viewMode]);

    const applyEdit = useCallback(
        (result: { value: string; selStart: number; selEnd: number }) => {
            setContent(result.value);
            // Restore selection after React commits the new value.
            requestAnimationFrame(() => {
                const ta = textareaRef.current;
                if (!ta) return;
                ta.focus();
                ta.setSelectionRange(result.selStart, result.selEnd);
            });
        },
        []
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            const ta = e.currentTarget;
            const { value, selectionStart: start, selectionEnd: end } = ta;

            // Tab / Shift+Tab: indent / outdent (line-aware).
            if (e.key === "Tab") {
                e.preventDefault();
                if (e.shiftKey) {
                    // Outdent selected lines.
                    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                    const segment = value.slice(lineStart, end);
                    const next = segment.replace(/^ {1,2}/, "");
                    const nextValue = value.slice(0, lineStart) + next + value.slice(end);
                    applyEdit({
                        value: nextValue,
                        selStart: lineStart,
                        selEnd: lineStart + next.length,
                    });
                } else {
                    const nextValue = value.slice(0, start) + "  " + value.slice(end);
                    applyEdit({
                        value: nextValue,
                        selStart: start + 2,
                        selEnd: start + 2,
                    });
                }
                return;
            }

            // Enter: continue list markers.
            if (e.key === "Enter" && !e.shiftKey) {
                const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                const line = value.slice(lineStart, end);
                const taskMatch = line.match(TASK_RE);
                const listMatch = line.match(LIST_RE);
                const match = taskMatch ?? listMatch;
                if (match) {
                    const [, indent, marker, rest] = match;
                    if (!rest) {
                        // Empty item - remove marker (outdent).
                        e.preventDefault();
                        const nextValue = value.slice(0, lineStart) + indent + value.slice(end);
                        applyEdit({
                            value: nextValue,
                            selStart: lineStart + indent.length,
                            selEnd: lineStart + indent.length,
                        });
                        return;
                    }
                    e.preventDefault();
                    let nextMarker = marker;
                    const numMatch = marker.match(/^(\d+)\./);
                    if (numMatch) nextMarker = `${Number(numMatch[1]) + 1}.`;
                    const insert = `\n${indent}${nextMarker} ${
                        taskMatch ? "[ ] " : ""
                    }`;
                    const nextValue = value.slice(0, start) + insert + value.slice(end);
                    const pos = start + insert.length;
                    applyEdit({ value: nextValue, selStart: pos, selEnd: pos });
                    return;
                }
            }

            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;

            if (e.key === "b" || e.key === "B") {
                e.preventDefault();
                const r = wrapSelection(value, start, end, "**", "**", "粗体");
                if (r) applyEdit(r);
            } else if (e.key === "i" || e.key === "I") {
                e.preventDefault();
                const r = wrapSelection(value, start, end, "*", "*", "斜体");
                if (r) applyEdit(r);
            } else if (e.key === "k" || e.key === "K") {
                if (e.shiftKey) {
                    e.preventDefault();
                    const r = wrapSelection(value, start, end, "```\n", "\n```", "代码块");
                    if (r) applyEdit(r);
                } else {
                    e.preventDefault();
                    const r = wrapSelection(value, start, end, "[", "](url)", "链接文字");
                    if (r) applyEdit(r);
                }
            } else if (e.key === "`") {
                e.preventDefault();
                const r = wrapSelection(value, start, end, "`", "`", "code");
                if (r) applyEdit(r);
            } else if (e.key === "s" || e.key === "S") {
                e.preventDefault(); // suppress browser save dialog
                setStatus("saving");
            }
        },
        [applyEdit]
    );

    const restoreDraft = async () => {
        const draft = await getDraft(note.uuid);
        if (!draft) {
            setDraftPrompt(false);
            return;
        }
        if (draft.title !== undefined) setTitle(draft.title);
        setContent(draft.contentMd);
        setDraftPrompt(false);
    };

    const discardDraft = async () => {
        await clearDraft(note.uuid);
        setDraftPrompt(false);
    };

    const words = wordCount(content);
    const readingMinutes = Math.max(1, Math.round(words / 350));

    return (
        <div className="flex h-full flex-col">
            {/* Scroll area - toolbar sticks to the top, content flows beneath */}
            <div className="flex-1 overflow-y-auto">
                {/* Toolbar */}
                <div className="sticky top-0 z-20 grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border-subtle bg-background/75 px-4 py-2 backdrop-blur-xl">
                    {/* Left: back (mobile only) */}
                    <div className="flex items-center justify-start">
                        <button
                            type="button"
                            onClick={onBack}
                            title="返回列表"
                            aria-label="返回列表"
                            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground md:hidden"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    </div>
                    {/* Center: view mode segmented control (write / read) */}
                    <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                        <SegBtn
                            active={viewMode === "write"}
                            onClick={() => setViewMode("write")}
                            icon={<Pencil className="h-3.5 w-3.5" />}
                            label="写作"
                        />
                        <SegBtn
                            active={viewMode === "read"}
                            onClick={() => setViewMode("read")}
                            icon={<Eye className="h-3.5 w-3.5" />}
                            label="阅读"
                        />
                    </div>
                    {/* Right: status + actions */}
                    <div className="flex items-center justify-end gap-1">
                        <StatusPill status={status} />
                        <button
                            type="button"
                            onClick={onShare}
                            title="分享"
                            aria-label="分享"
                            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                        >
                            <Share2 className="h-[18px] w-[18px]" />
                        </button>
                        <button
                            type="button"
                            onClick={onDelete}
                            title="删除"
                            aria-label="删除"
                            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-danger/5 hover:text-danger"
                        >
                            <Trash2 className="h-[18px] w-[18px]" />
                        </button>
                    </div>
                </div>

                {/* Content - fills the available width, wraps when full */}
                <div className="px-6 pb-24 pt-10 sm:px-10">
                    {/* Draft recovery bar */}
                    {draftPrompt && (
                        <div className="mb-6 flex items-center gap-2 rounded-xl border border-warning/20 bg-warning/5 px-3.5 py-2.5 text-[12px] text-foreground">
                            <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" />
                            <span className="flex-1">检测到未保存的草稿，是否恢复？</span>
                            <button
                                type="button"
                                onClick={() => void restoreDraft()}
                                className="rounded-md bg-warning/10 px-2 py-1 font-medium text-warning hover:bg-warning/20"
                            >
                                恢复
                            </button>
                            <button
                                type="button"
                                onClick={() => void discardDraft()}
                                className="rounded-md px-2 py-1 text-secondary hover:bg-border-subtle"
                            >
                                丢弃
                            </button>
                        </div>
                    )}

                    {/* Title */}
                    <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="无标题"
                        className="w-full bg-transparent text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground outline-none placeholder:text-tertiary/50"
                    />

                    {/* Meta */}
                    <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-secondary">
                        <span>{new Date(note.updatedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</span>
                        <span className="text-tertiary">·</span>
                        <span>{words} 字</span>
                        <span className="text-tertiary">·</span>
                        <span>约 {readingMinutes} 分钟</span>
                        <span className="text-tertiary">·</span>
                        <span>{note.revisionCount} 次修订</span>
                    </p>

                    {/* Editor (write) or preview (read) */}
                    <div className="mt-8">
                        {viewMode === "write" ? (
                            <div className="min-h-[60vh]">
                                <textarea
                                    ref={textareaRef}
                                    value={content}
                                    onChange={(e) => setContent(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    spellCheck={false}
                                    placeholder="从此处开始落笔…"
                                    className="note-textarea w-full resize-none bg-transparent text-[16px] leading-[1.75] text-foreground outline-none placeholder:text-tertiary/50"
                                />
                            </div>
                        ) : (
                            <div className="min-h-[60vh]">
                                {content.trim() ? (
                                    <div className="note-prose">
                                        <Markdown>{content}</Markdown>
                                    </div>
                                ) : (
                                    <div className="flex min-h-[40vh] items-center justify-center">
                                        <p className="text-[13px] text-tertiary">
                                            还没有内容
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── sub-components ────────────────────────────────────────────────

function SegBtn({
    active,
    onClick,
    icon,
    label,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-200",
                active ? "text-foreground" : "text-secondary hover:text-foreground"
            )}
        >
            {active && (
                <motion.span
                    layoutId="note-seg-active"
                    className="absolute inset-0 rounded-md bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.6 }}
                />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
                {icon}
                <span className="hidden sm:inline">{label}</span>
            </span>
        </button>
    );
}

function StatusPill({ status }: { status: SaveStatus }) {
    if (status === "idle") return null;
    const map = {
        saving: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "保存中", cls: "text-secondary" },
        saved: { icon: <Check className="h-3 w-3" />, text: "已保存", cls: "text-success" },
        error: { icon: <AlertCircle className="h-3 w-3" />, text: "保存失败", cls: "text-danger" },
        conflict: { icon: <AlertCircle className="h-3 w-3" />, text: "冲突", cls: "text-accent" },
    } as const;
    const m = map[status];
    return (
        <span className={cn("mr-1 inline-flex items-center gap-1 text-[11px]", m.cls)}>
            {m.icon}
            <span className="hidden sm:inline">{m.text}</span>
        </span>
    );
}
