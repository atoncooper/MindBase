"use client";

/**
 * CloudDriveView - orchestrator for the cloud drive page.
 *
 * Three-pane Finder-style shell: folder sidebar + main file area (toolbar +
 * list/grid) + right inspector. Owns the full state machine: folder tree,
 * paginated file list, selection + detail, view/sort preferences (persisted
 * to localStorage), chunked upload with progress, processing-status polling,
 * and folder/file delete. All data flows through lib/api/cloud (cloudApi).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import {
    cloudApi,
    type CloudFolderTreeItem,
    type CloudVideoItem,
    type CloudVideoDetailResponse,
} from "@/lib/api/cloud";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { FolderSidebar } from "./folder-sidebar";
import { FileToolbar, type ViewMode, type SortField, type SortOrder } from "./file-toolbar";
import { FileList } from "./file-list";
import { FileGrid } from "./file-grid";
import { FileInspector } from "./file-inspector";
import { UploadDropzone, UploadProgressPill } from "./upload-dropzone";
import { FileListSkeleton, NoFiles } from "./empty-states";

const PAGE_SIZE = 50;

export function CloudDriveView() {
    // ── Folders ──
    const [folders, setFolders] = useState<CloudFolderTreeItem[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(true);
    const [selectedFolderId, setSelectedFolderId] = useState<number | null>(() => {
        // Restore the last-opened folder so returning from the viewer lands
        // back in the same directory rather than the root.
        const v = readPref("cloud-drive:folder", "");
        if (!v) return null;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    });

    // ── Files ──
    const [videos, setVideos] = useState<CloudVideoItem[]>([]);
    const [videosLoading, setVideosLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    // ── Selection / detail ──
    const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
    const [detail, setDetail] = useState<CloudVideoDetailResponse | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);

    // ── Preferences (persisted) ──
    const [view, setView] = useState<ViewMode>(() => readPref("cloud-drive:view", "list") as ViewMode);
    const [sort, setSort] = useState<SortField>(() => readPref("cloud-drive:sort", "created_at") as SortField);
    const [order, setOrder] = useState<SortOrder>(() => readPref("cloud-drive:order", "desc") as SortOrder);

    // ── Upload ──
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadName, setUploadName] = useState("");
    const [uploadDone, setUploadDone] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Processing poll set ──
    const [processingUuids, setProcessingUuids] = useState<Set<string>>(new Set());

    // ── Dialogs ──
    const [deleteFolderTarget, setDeleteFolderTarget] = useState<CloudFolderTreeItem | null>(null);
    const [deleteFileUuid, setDeleteFileUuid] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState(false);

    // Persist preferences.
    useEffect(() => { writePref("cloud-drive:view", view); }, [view]);
    useEffect(() => { writePref("cloud-drive:sort", sort); }, [sort]);
    useEffect(() => { writePref("cloud-drive:order", order); }, [order]);
    useEffect(() => {
        writePref("cloud-drive:folder", selectedFolderId == null ? "" : String(selectedFolderId));
    }, [selectedFolderId]);

    // ── Data loaders ──
    const refreshFolders = useCallback(async () => {
        setFoldersLoading(true);
        try {
            const res = await cloudApi.listFolders();
            setFolders(res.folders);
        } catch {
            // Non-fatal: empty tree is a valid state.
        } finally {
            setFoldersLoading(false);
        }
    }, []);

    const refreshVideos = useCallback(
        async (folderId: number | null, nextPage: number, append: boolean) => {
            if (!append) setVideosLoading(true);
            try {
                const res = await cloudApi.listVideos(folderId, nextPage, PAGE_SIZE, sort, order);
                setVideos((prev) => (append ? [...prev, ...res.videos] : res.videos));
                setPage(res.page);
                setHasMore(res.hasMore);
                // Seed the processing-poll set from any in-flight items.
                const inflight = res.videos
                    .filter((v) => v.vectorStatus === "processing" || v.asrStatus === "processing")
                    .map((v) => v.uploadUuid);
                if (inflight.length) {
                    setProcessingUuids((prev) => new Set([...prev, ...inflight]));
                }
            } catch {
                // Keep stale list on transient error.
            } finally {
                setVideosLoading(false);
            }
        },
        [sort, order]
    );

    const refreshDetail = useCallback(async (uuid: string) => {
        setLoadingDetail(true);
        try {
            const d = await cloudApi.getVideoDetail(uuid);
            setDetail(d);
        } catch {
            // Keep stale.
        } finally {
            setLoadingDetail(false);
        }
    }, []);

    // Initial load.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshFolders();
        void refreshVideos(selectedFolderId, 1, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reload files when folder / sort / order changes.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshVideos(selectedFolderId, 1, false);
    }, [selectedFolderId, sort, order, refreshVideos]);

    // Invalidate the persisted folder if it was deleted elsewhere (e.g. in
    // another tab) so we don't sit on a stale id with an empty file list.
    useEffect(() => {
        if (selectedFolderId == null || foldersLoading || folders.length === 0) return;
        if (findFolderName(folders, selectedFolderId) == null) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSelectedFolderId(null);
        }
    }, [selectedFolderId, folders, foldersLoading]);

    // Fetch detail on selection.
    useEffect(() => {
        if (!selectedUuid) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDetail(null);
            return;
        }
        void refreshDetail(selectedUuid);
    }, [selectedUuid, refreshDetail]);

    // ── Processing status poll (4s while any item is in flight) ──
    useEffect(() => {
        if (processingUuids.size === 0) return;
        const ids = Array.from(processingUuids);
        const timer = setInterval(async () => {
            const still: string[] = [];
            for (const uuid of ids) {
                try {
                    const s = await cloudApi.getVideoStatus(uuid);
                    setVideos((prev) =>
                        prev.map((v) =>
                            v.uploadUuid === uuid
                                ? { ...v, vectorStatus: s.vectorStatus, asrStatus: s.asrStatus }
                                : v
                        )
                    );
                    setDetail((prev) =>
                        prev && prev.uploadUuid === uuid
                            ? {
                                  ...prev,
                                  vectorStatus: s.vectorStatus,
                                  asrStatus: s.asrStatus,
                                  vectorChunkCount: s.vectorChunkCount,
                              }
                            : prev
                    );
                    if (s.vectorStatus === "processing" || s.asrStatus === "processing") {
                        still.push(uuid);
                    }
                } catch {
                    still.push(uuid); // keep polling on transient error
                }
            }
            setProcessingUuids(new Set(still));
        }, 4000);
        return () => clearInterval(timer);
    }, [processingUuids]);

    // ── Handlers ──
    const handleSelectFolder = useCallback((id: number | null) => {
        setSelectedFolderId(id);
        setSelectedUuid(null);
    }, []);

    const handleSelectFile = useCallback((uuid: string) => {
        setSelectedUuid(uuid);
        setDetail(null);
    }, []);

    const handleLoadMore = useCallback(async () => {
        setLoadingMore(true);
        try {
            const res = await cloudApi.listVideos(selectedFolderId, page + 1, PAGE_SIZE, sort, order);
            setVideos((prev) => [...prev, ...res.videos]);
            setPage(res.page);
            setHasMore(res.hasMore);
        } catch {
            // Non-fatal.
        } finally {
            setLoadingMore(false);
        }
    }, [selectedFolderId, page, sort, order]);

    const handleFiles = useCallback(
        async (files: FileList) => {
            const list = Array.from(files);
            if (list.length === 0) return;
            setUploading(true);
            setUploadDone(false);
            try {
                for (const file of list) {
                    setUploadName(file.name);
                    setUploadProgress(0);
                    await cloudApi.uploadFile(file, selectedFolderId, (pct) =>
                        setUploadProgress(pct)
                    );
                    setUploadDone(true);
                    // Brief "done" flash before the next file / teardown.
                    await new Promise((r) => setTimeout(r, 600));
                    setUploadDone(false);
                }
                await refreshVideos(selectedFolderId, 1, false);
            } catch {
                // TODO: surface a toast once a host exists.
            } finally {
                setUploading(false);
                setUploadProgress(0);
                setUploadName("");
                setUploadDone(false);
            }
        },
        [selectedFolderId, refreshVideos]
    );

    const handleCreateFolder = useCallback(
        async (name: string, parentId: number | null) => {
            await cloudApi.createFolder({ parentId, name });
            await refreshFolders();
        },
        [refreshFolders]
    );

    const handleRenameFolder = useCallback(
        async (id: number, name: string) => {
            await cloudApi.updateFolder(id, { name });
            await refreshFolders();
        },
        [refreshFolders]
    );

    const handleDeleteFolder = useCallback(async () => {
        const target = deleteFolderTarget;
        if (!target) return;
        setBusyAction(true);
        try {
            await cloudApi.deleteFolder(target.id, true);
            setDeleteFolderTarget(null);
            if (selectedFolderId === target.id) setSelectedFolderId(null);
            await refreshFolders();
            await refreshVideos(selectedFolderId, 1, false);
        } catch {
            // Keep dialog open on failure.
        } finally {
            setBusyAction(false);
        }
    }, [deleteFolderTarget, selectedFolderId, refreshFolders, refreshVideos]);

    const handleDeleteFile = useCallback(async () => {
        const uuid = deleteFileUuid;
        if (!uuid) return;
        setBusyAction(true);
        try {
            await cloudApi.deleteVideo(uuid);
            setDeleteFileUuid(null);
            if (selectedUuid === uuid) {
                setSelectedUuid(null);
                setDetail(null);
            }
            setVideos((prev) => prev.filter((v) => v.uploadUuid !== uuid));
            await refreshFolders();
        } catch {
            // Keep dialog open.
        } finally {
            setBusyAction(false);
        }
    }, [deleteFileUuid, selectedUuid, refreshFolders]);

    const handleProcess = useCallback(
        async (uuid: string) => {
            setProcessingUuids((prev) => new Set([...prev, uuid]));
            // Optimistically flip the list + detail to processing.
            setVideos((prev) =>
                prev.map((v) =>
                    v.uploadUuid === uuid ? { ...v, vectorStatus: "processing" } : v
                )
            );
            setDetail((prev) =>
                prev && prev.uploadUuid === uuid ? { ...prev, vectorStatus: "processing" } : prev
            );
            try {
                await cloudApi.triggerProcess(uuid);
            } catch {
                setProcessingUuids((prev) => {
                    const next = new Set(prev);
                    next.delete(uuid);
                    return next;
                });
            }
        },
        []
    );

    // ── Derived ──
    const totalFiles = folders.reduce((sum, f) => sum + (f.videoCount || 0), 0) + videos.length;
    const currentFolderName =
        selectedFolderId == null
            ? "全部文件"
            : findFolderName(folders, selectedFolderId) ?? "文件夹";

    return (
        <div className="flex h-[calc(100dvh-3rem)] overflow-hidden">
            {/* Sidebar */}
            <aside className="hidden w-64 shrink-0 border-r border-border-subtle bg-surface md:block">
                <FolderSidebar
                    folders={folders}
                    loading={foldersLoading}
                    selectedFolderId={selectedFolderId}
                    totalCount={videosLoading ? 0 : totalFiles}
                    onSelect={handleSelectFolder}
                    onCreateFolder={handleCreateFolder}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={setDeleteFolderTarget}
                />
            </aside>

            {/* Main */}
            <main className="flex min-w-0 flex-1 flex-col bg-background">
                <UploadDropzone onFiles={(files) => void handleFiles(files)}>
                    <FileToolbar
                        title={currentFolderName}
                        view={view}
                        onViewChange={setView}
                        sort={sort}
                        order={order}
                        onSortChange={(f, o) => {
                            setSort(f);
                            setOrder(o);
                        }}
                        onUploadClick={() => fileInputRef.current?.click()}
                        uploading={uploading}
                    />
                    <div className="flex-1 overflow-y-auto">
                        {videosLoading ? (
                            <FileListSkeleton />
                        ) : videos.length === 0 ? (
                            <NoFiles />
                        ) : view === "list" ? (
                            <FileList
                                videos={videos}
                                selectedUuid={selectedUuid}
                                onSelect={handleSelectFile}
                                hasMore={hasMore}
                                loadingMore={loadingMore}
                                onLoadMore={() => void handleLoadMore()}
                            />
                        ) : (
                            <FileGrid
                                videos={videos}
                                selectedUuid={selectedUuid}
                                onSelect={handleSelectFile}
                                hasMore={hasMore}
                                loadingMore={loadingMore}
                                onLoadMore={() => void handleLoadMore()}
                            />
                        )}
                    </div>
                </UploadDropzone>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        if (e.target.files?.length) void handleFiles(e.target.files);
                        e.target.value = "";
                    }}
                />
            </main>

            {/* Inspector (inline on lg+, full-screen overlay below) */}
            <AnimatePresence>
                {selectedUuid && (
                    <motion.aside
                        key="inspector"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className={cn(
                            "fixed bottom-0 left-0 right-0 top-12 z-40 border-border-subtle bg-surface lg:static lg:z-auto lg:w-80 lg:border-l"
                        )}
                    >
                        {detail ? (
                            <FileInspector
                                detail={detail}
                                processing={processingUuids.has(detail.uploadUuid)}
                                onProcess={(uuid) => void handleProcess(uuid)}
                                onDelete={(uuid) => setDeleteFileUuid(uuid)}
                                onBack={() => setSelectedUuid(null)}
                            />
                        ) : loadingDetail ? (
                            <div className="flex h-full w-full items-center justify-center">
                                <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                            </div>
                        ) : null}
                    </motion.aside>
                )}
            </AnimatePresence>

            {/* Upload progress pill */}
            {uploading && (
                <UploadProgressPill
                    name={uploadName}
                    pct={uploadProgress}
                    done={uploadDone}
                />
            )}

            {/* Delete folder confirm */}
            <ConfirmDialog
                open={deleteFolderTarget !== null}
                title="删除文件夹？"
                message={
                    deleteFolderTarget
                        ? `「${deleteFolderTarget.name}」及其所有文件将被删除，此操作不可撤销。`
                        : ""
                }
                confirmLabel="删除"
                danger
                busy={busyAction}
                onConfirm={() => void handleDeleteFolder()}
                onCancel={() => (busyAction ? undefined : setDeleteFolderTarget(null))}
            />

            {/* Delete file confirm */}
            <ConfirmDialog
                open={deleteFileUuid !== null}
                title="删除文件？"
                message="文件及其向量数据将被删除，此操作不可撤销。"
                confirmLabel="删除"
                danger
                busy={busyAction}
                onConfirm={() => void handleDeleteFile()}
                onCancel={() => (busyAction ? undefined : setDeleteFileUuid(null))}
            />
        </div>
    );
}

// ── helpers ──────────────────────────────────────────────────────

function readPref(key: string, fallback: string): string {
    if (typeof window === "undefined") return fallback;
    return localStorage.getItem(key) ?? fallback;
}

function writePref(key: string, value: string): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, value);
}

function findFolderName(
    folders: CloudFolderTreeItem[],
    id: number
): string | null {
    for (const f of folders) {
        if (f.id === id) return f.name;
        const found = findFolderName(f.children, id);
        if (found) return found;
    }
    return null;
}
