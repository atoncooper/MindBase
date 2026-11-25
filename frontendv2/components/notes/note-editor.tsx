"use client";

/**
 * Note editor — Notion-like WYSIWYG only.
 *
 * Blocks are edited directly (BlockNote) and converted back to Markdown for
 * storage. Autosave is debounced (1.5s), optimistic with If-Match concurrency,
 * and backed by an IndexedDB draft so in-flight typing survives crashes.
 * Markdown stays the canonical format (share/export/agent paths unchanged).
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
    Share2,
    Trash2,
    Loader2,
    Check,
    AlertCircle,
    CloudOff,
    ArrowLeft,
    ListTree,
    X,
} from "lucide-react";
import type { NoteDetail } from "@/lib/api/notes";
import { notesApi } from "@/lib/api/notes";
import { cn } from "@/lib/utils";
import { saveDraft, getDraft, clearDraft } from "./draft-store";
import type { BlockNoteHandle, OutlineItem } from "./blocknote-editor";

// BlockNote is DOM-only and heavy: keep it out of SSR and the initial chunk.
const BlockNoteMarkdownEditor = dynamic(
    () => import("./blocknote-editor").then((m) => m.BlockNoteMarkdownEditor),
    {
        ssr: false,
        loading: () => (
            <div className="h-[40vh] w-full animate-pulse rounded-lg bg-border-subtle/30" />
        ),
    }
);

type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

interface NoteEditorProps {
    note: NoteDetail;
    onChanged: () => void;
    onDelete: () => void;
    onShare: () => void;
    onBack: () => void; // mobile: back to list
}

const SAVE_DEBOUNCE_MS = 1500;

function wordCount(md: string): number {
    return md
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/[#>*_~\[\]()!]/g, "")
        .replace(/\s/g, "")
        .length;
}

export function NoteEditor({ note, onChanged, onDelete, onShare, onBack }: NoteEditorProps) {
    const [title, setTitle] = useState(note.title);
    const [content, setContent] = useState(note.contentMd);
    const [status, setStatus] = useState<SaveStatus>("idle");
    // Remounts the rich editor when content is replaced from outside (draft).
    const [editorEpoch, setEditorEpoch] = useState(0);
    const [draftPrompt, setDraftPrompt] = useState(false);
    const [outline, setOutline] = useState<OutlineItem[]>([]);
    const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
    const editorApiRef = useRef<BlockNoteHandle | null>(null);
    const serverUpdatedAtRef = useRef<string>(note.updatedAt);
    const latestRef = useRef({ title, content, uuid: note.uuid });
    // Last-known saved (server) copy of the note. The hide/unload flush compares
    // against it so a fully-saved note never writes a new draft.
    const savedSnapshotRef = useRef({ title: note.title, content: note.contentMd });

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
        savedSnapshotRef.current = { title: note.title, content: note.contentMd };
        setDraftPrompt(false);
        setOutline([]);
        /* eslint-enable react-hooks/set-state-in-effect */
        let cancelled = false;
        void (async () => {
            const draft = await getDraft(note.uuid);
            if (cancelled || !draft) return;
            // A draft identical to the server copy is residue from a completed
            // save (e.g. written by an old flush) - drop it silently, never
            // surface a bogus "恢复草稿" prompt.
            const sameTitle = draft.title === undefined || draft.title === note.title;
            if (sameTitle && draft.contentMd === note.contentMd) {
                await clearDraft(note.uuid);
                return;
            }
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
                    savedSnapshotRef.current = { title, content };
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
            const saved = savedSnapshotRef.current;
            if (t === saved.title && c === saved.content) {
                // Everything is already on the server - clear any stale draft
                // instead of writing one. The old unconditional write stamped
                // savedAt=now on fully-saved notes, so the next visit always
                // saw draft.savedAt > updatedAt and prompted a bogus recovery.
                void clearDraft(uuid);
                return;
            }
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

    const restoreDraft = async () => {
        const draft = await getDraft(note.uuid);
        if (!draft) {
            setDraftPrompt(false);
            return;
        }
        if (draft.title !== undefined) setTitle(draft.title);
        setContent(draft.contentMd);
        // Remount the rich editor with the recovered Markdown.
        setEditorEpoch((v) => v + 1);
        setDraftPrompt(false);
    };

    const discardDraft = async () => {
        await clearDraft(note.uuid);
        setDraftPrompt(false);
    };

    const words = wordCount(content);
    const readingMinutes = Math.max(1, Math.round(words / 350));

    return (
        <div className="flex h-full flex-col bg-background">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle/70 bg-background/80 px-4 py-2 backdrop-blur-xl">
                <button
                    type="button"
                    onClick={onBack}
                    title="返回列表"
                    aria-label="返回列表"
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="flex items-center justify-end gap-1">
                    <button
                        type="button"
                        onClick={() => setMobileOutlineOpen(true)}
                        title="大纲"
                        aria-label="查看大纲"
                        className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground xl:hidden"
                    >
                        <ListTree className="h-[18px] w-[18px]" />
                    </button>
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

            {/* Body: fixed title/meta header + the WYSIWYG surface */}
            <div className="min-h-0 flex-1 overflow-hidden">
                <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col px-5 pt-8 sm:px-8">
                    <div className="shrink-0 xl:max-w-[860px]">
                        {draftPrompt && (
                            <div className="mb-5 flex items-center gap-2 rounded-xl border border-warning/20 bg-warning/5 px-3.5 py-2.5 text-[12px] text-foreground">
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

                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="无标题"
                            className="w-full bg-transparent text-[32px] font-bold leading-[1.2] tracking-[-0.025em] text-foreground outline-none placeholder:text-tertiary/40 sm:text-[36px]"
                        />
                        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-secondary">
                            <span>
                                {new Date(note.updatedAt).toLocaleDateString("zh-CN", {
                                    year: "numeric",
                                    month: "long",
                                    day: "numeric",
                                })}
                            </span>
                            <span className="text-tertiary">·</span>
                            <span>{words} 字</span>
                            <span className="text-tertiary">·</span>
                            <span>约 {readingMinutes} 分钟</span>
                            <span className="text-tertiary">·</span>
                            <span>{note.revisionCount} 次修订</span>
                        </p>
                    </div>

                    <div className="mt-5 flex min-h-0 flex-1">
                        <div className="min-w-0 flex-1 overflow-y-auto pb-24 xl:max-w-[860px]">
                            <BlockNoteMarkdownEditor
                                key={editorEpoch}
                                initialMarkdown={content}
                                onChange={setContent}
                                onOutlineChange={setOutline}
                                onReady={(api) => {
                                    editorApiRef.current = api;
                                }}
                            />
                        </div>
                        <aside className="hidden w-60 shrink-0 overflow-y-auto border-l border-border-subtle/60 pb-24 pl-5 xl:block">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
                                大纲
                            </p>
                            <OutlineNav
                                items={outline}
                                onSelect={(id) => editorApiRef.current?.scrollToBlock(id)}
                            />
                        </aside>
                    </div>
                </div>
            </div>

            {mobileOutlineOpen && (
                <div
                    className="fixed inset-0 z-50 bg-black/20 xl:hidden"
                    onClick={() => setMobileOutlineOpen(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="笔记大纲"
                >
                    <aside
                        className="absolute right-0 top-0 h-full w-72 overflow-y-auto border-l border-border-subtle bg-surface px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
                                大纲
                            </p>
                            <button
                                type="button"
                                onClick={() => setMobileOutlineOpen(false)}
                                aria-label="关闭大纲"
                                className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <OutlineNav
                            items={outline}
                            onSelect={(id) => {
                                editorApiRef.current?.scrollToBlock(id);
                                setMobileOutlineOpen(false);
                            }}
                        />
                    </aside>
                </div>
            )}
        </div>
    );
}

function OutlineNav({ items, onSelect }: { items: OutlineItem[]; onSelect: (id: string) => void }) {
    if (items.length === 0) {
        return (
            <p className="mt-3 text-[11.5px] leading-relaxed text-tertiary">
                还没有标题。用「标题 1 / 2 / 3」块组织内容后，这里会显示大纲。
            </p>
        );
    }
    return (
        <nav className="mt-2 flex flex-col gap-0.5">
            {items.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    title={item.text}
                    style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
                    className="truncate rounded-md py-1 pr-1.5 text-left text-[12.5px] leading-5 text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    {item.text}
                </button>
            ))}
        </nav>
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
