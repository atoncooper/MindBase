"use client";

/**
 * NotesView - orchestrator for the notes page.
 *
 * Owns the list + detail state machine: loads the note list, fetches detail on
 * selection, handles create / delete / pin / share, and refreshes detail after
 * the editor autosaves. Layout is a left list + right editor; on mobile only
 * one pane is visible at a time (list by default, editor on tap).
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { NotebookPen, Plus, Loader2 } from "lucide-react";
import {
    notesApi,
    type NoteMeta,
    type NoteDetail,
    type NoteShareInfo,
} from "@/lib/api/notes";
import { cn } from "@/lib/utils";
import { NotesList } from "./notes-list";
import { NoteEditor } from "./note-editor";
import { ShareDialog } from "./share-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";

export function NotesView() {
    const [notes, setNotes] = useState<NoteMeta[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
    const [detail, setDetail] = useState<NoteDetail | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [mobileEditor, setMobileEditor] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [deleteUuid, setDeleteUuid] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState(false);

    const refreshList = useCallback(async (autoSelect: boolean) => {
        setLoading(true);
        try {
            const list = await notesApi.list({ pageSize: 100 });
            list.sort((a, b) => {
                if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
                return b.updatedAt.localeCompare(a.updatedAt);
            });
            setNotes(list);
            if (autoSelect && list.length > 0 && !selectedUuid) {
                setSelectedUuid(list[0].uuid);
            }
        } catch {
            // Non-fatal: empty list is a valid state.
        } finally {
            setLoading(false);
        }
    }, [selectedUuid]);

    const refreshDetail = useCallback(async (uuid: string) => {
        setLoadingDetail(true);
        try {
            const d = await notesApi.get(uuid);
            setDetail(d);
        } catch {
            // Keep stale detail rather than blanking on a transient error.
        } finally {
            setLoadingDetail(false);
        }
    }, []);

    // Initial load.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshList(true);
    }, [refreshList]);

    // Fetch detail whenever the selection changes. (detail is cleared at the
    // delete site, so no synchronous reset is needed here.)
    useEffect(() => {
        if (!selectedUuid) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshDetail(selectedUuid);
    }, [selectedUuid, refreshDetail]);

    const handleSelect = useCallback((uuid: string) => {
        setSelectedUuid(uuid);
        // Clear stale detail so the loader (not the previous note) shows while
        // the new one fetches.
        setDetail(null);
        setMobileEditor(true);
    }, []);

    const handleNew = useCallback(async () => {
        setBusyAction(true);
        try {
            const created = await notesApi.create({
                targetType: "video",
                targetId: `scratch:${Date.now()}`,
                title: "无标题",
                contentMd: "",
            });
            await refreshList(false);
            setSelectedUuid(created.uuid);
            setMobileEditor(true);
        } catch {
            // TODO: surface a toast once we have a toast host.
        } finally {
            setBusyAction(false);
        }
    }, [refreshList]);

    const handleTogglePin = useCallback(
        async (uuid: string, isPinned: boolean) => {
            // Optimistic: update list immediately, revert on failure.
            setNotes((prev) =>
                prev.map((n) => (n.uuid === uuid ? { ...n, isPinned: !isPinned } : n))
            );
            try {
                await notesApi.update(uuid, { isPinned: !isPinned });
                await refreshList(false);
            } catch {
                setNotes((prev) =>
                    prev.map((n) => (n.uuid === uuid ? { ...n, isPinned } : n))
                );
            }
        },
        [refreshList]
    );

    const handleDelete = useCallback(async () => {
        const uuid = deleteUuid;
        if (!uuid) return;
        setBusyAction(true);
        try {
            await notesApi.delete(uuid);
            setDeleteUuid(null);
            if (selectedUuid === uuid) {
                setSelectedUuid(null);
                setDetail(null);
                setMobileEditor(false);
            }
            await refreshList(false);
        } catch {
            // Keep dialog open on failure so the error is visible.
        } finally {
            setBusyAction(false);
        }
    }, [deleteUuid, selectedUuid, refreshList]);

    const handleShareChanged = useCallback((info: NoteShareInfo | null) => {
        setDetail((prev) =>
            prev
                ? {
                      ...prev,
                      shareToken: info?.shareToken ?? null,
                      shareExpiresAt: info?.expiresAt ?? null,
                  }
                : prev
        );
    }, []);

    const handleEditorChanged = useCallback(() => {
        if (selectedUuid) {
            void refreshDetail(selectedUuid);
            void refreshList(false);
        }
    }, [selectedUuid, refreshDetail, refreshList]);

    const handleBack = useCallback(() => setMobileEditor(false), []);

    return (
        <div className="flex h-[calc(100dvh-3rem)] overflow-hidden">
            {/* List sidebar */}
            <aside
                className={cn(
                    "w-72 shrink-0 border-r border-border-subtle bg-surface",
                    mobileEditor && "hidden md:block"
                )}
            >
                <NotesList
                    notes={notes}
                    loading={loading}
                    selectedUuid={selectedUuid}
                    onSelect={handleSelect}
                    onNew={() => void handleNew()}
                    onTogglePin={(uuid, pinned) => void handleTogglePin(uuid, pinned)}
                />
            </aside>

            {/* Editor pane */}
            <main
                className={cn(
                    "min-w-0 flex-1 bg-background",
                    !mobileEditor && "hidden md:block"
                )}
            >
                {selectedUuid && detail ? (
                    // Has detail -> always show editor, even during a silent
                    // refresh (so autosave never flashes a loader).
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={detail.uuid}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="h-full"
                        >
                            <NoteEditor
                                note={detail}
                                onChanged={handleEditorChanged}
                                onDelete={() => setDeleteUuid(detail.uuid)}
                                onShare={() => setShareOpen(true)}
                                onBack={handleBack}
                            />
                        </motion.div>
                    </AnimatePresence>
                ) : selectedUuid && loadingDetail ? (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                    </div>
                ) : (
                    <EmptyState
                        hasNotes={notes.length > 0}
                        onNew={() => void handleNew()}
                        busy={busyAction}
                    />
                )}
            </main>

            {/* Share dialog */}
            {detail && (
                <ShareDialog
                    open={shareOpen}
                    uuid={detail.uuid}
                    shareToken={detail.shareToken}
                    shareExpiresAt={detail.shareExpiresAt}
                    onClose={() => setShareOpen(false)}
                    onShareChanged={handleShareChanged}
                />
            )}

            {/* Delete confirm */}
            <ConfirmDialog
                open={deleteUuid !== null}
                title="删除这条笔记？"
                message="此操作不可撤销，笔记正文与修订将被删除。"
                confirmLabel="删除"
                danger
                busy={busyAction}
                onConfirm={() => void handleDelete()}
                onCancel={() => (busyAction ? undefined : setDeleteUuid(null))}
            />
        </div>
    );
}

function EmptyState({
    hasNotes,
    onNew,
    busy,
}: {
    hasNotes: boolean;
    onNew: () => void;
    busy: boolean;
}) {
    return (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <NotebookPen className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">
                {hasNotes ? "选择一条笔记" : "开始你的第一篇笔记"}
            </p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                {hasNotes
                    ? "从左侧选择一篇笔记开始编辑，或新建一条。"
                    : "用 Markdown 写下想法，支持分屏预览与自动保存。"}
            </p>
            <button
                type="button"
                disabled={busy}
                onClick={onNew}
                className="btn-pill btn-primary mt-6 h-9 px-5 text-[13px]"
            >
                {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <Plus className="h-4 w-4" />
                )}
                新建笔记
            </button>
        </div>
    );
}
