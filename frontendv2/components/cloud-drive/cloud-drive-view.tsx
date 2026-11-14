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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import {
    cloudApi,
    type CloudFolderTreeItem,
    type CloudVideoItem,
    type CloudVideoDetailResponse,
    type RefItem,
    type SemanticHit,
} from "@/lib/api/cloud";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { FolderSidebar } from "./folder-sidebar";
import {
    FileToolbar,
    type ViewMode,
    type SortField,
    type SortOrder,
    type SearchMode,
} from "./file-toolbar";
import { SemanticResults } from "./semantic-results";
import { FileList } from "./file-list";
import { FileGrid } from "./file-grid";
import { FileInspector } from "./file-inspector";
import { RefInspector } from "./ref-inspector";
import { ResearchFilesDialog } from "./research-files-dialog";
import { ShareDialog } from "./share-dialog";
import { formatBytes, type CloudQuotaResponse, type CloudTrashItem } from "@/lib/api/cloud";
import { UploadDropzone, UploadProgressPill } from "./upload-dropzone";
import { FileListSkeleton, NoFiles } from "./empty-states";
import { emitAppToast } from "@/lib/app-toast";

const PAGE_SIZE = 50;

export function CloudDriveView() {
    const router = useRouter(); // 引用预览跳转 /cloud-drive/refs/[id]
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

    // ── app-cloud 新能力：配额 / 搜索 / 回收站 / 分享 ──
    const [quota, setQuota] = useState<CloudQuotaResponse | null>(null);
    const [searchQ, setSearchQ] = useState("");
    const [searchMode, setSearchMode] = useState<SearchMode>("name");
    const [searchResults, setSearchResults] = useState<CloudVideoItem[] | null>(null);
    const [searching, setSearching] = useState(false);
    // 语义检索：结果与「查询+范围」的 key 绑定，key 不匹配时按加载中处理，
    // 避免切换文件夹/模式后短暂显示上一组结果。
    const [semanticResults, setSemanticResults] = useState<SemanticHit[] | null>(null);
    const [semanticKey, setSemanticKey] = useState<string | null>(null);
    const [semanticLoading, setSemanticLoading] = useState(false);
    const [semanticError, setSemanticError] = useState<string | null>(null);
    const [semanticReloadKey, setSemanticReloadKey] = useState(0);
    // 语义模式是否限定在当前文件夹（根目录下不生效）
    const [semanticOnlyFolder, setSemanticOnlyFolder] = useState(true);
    const [trashOpen, setTrashOpen] = useState(false);
    const [trashItems, setTrashItems] = useState<CloudTrashItem[]>([]);
    const [trashCount, setTrashCount] = useState(0);
    const [trashLoading, setTrashLoading] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [detail, setDetail] = useState<CloudVideoDetailResponse | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    // ── cloud_refs 引用（保存到我的云盘，非复制；plan/1.0.16 §6）──
    const [refs, setRefs] = useState<RefItem[]>([]);
    const [selectedRefId, setSelectedRefId] = useState<number | null>(null);
    const [deleteRefTarget, setDeleteRefTarget] = useState<RefItem | null>(null);
    // 文件夹分享目标（folder-sidebar 入口；null = 文件分享模式）
    const [folderShareTarget, setFolderShareTarget] = useState<CloudFolderTreeItem | null>(null);

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
    // Last known vector status + display name per file. The poll compares
    // against this so a terminal transition fires exactly one toast, while
    // list reloads (which also set statuses) never spam the user.
    const lastVectorStatusRef = useRef<Map<string, string>>(new Map());
    const fileNameRef = useRef<Map<string, string>>(new Map());
    const notifiedVectorRef = useRef<Set<string>>(new Set());

    // ── Dialogs ──
    const [deleteFolderTarget, setDeleteFolderTarget] = useState<CloudFolderTreeItem | null>(null);
    const [deleteFileUuid, setDeleteFileUuid] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState(false);
    // 手机端文件夹抽屉（md 以上为常驻侧栏，此状态不生效）
    const [foldersOpen, setFoldersOpen] = useState(false);
    // 云盘「科研项目文件」只读弹层（入口在侧栏；只读，不改科研目录结构）
    const [researchFilesOpen, setResearchFilesOpen] = useState(false);

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

    // 侧栏展示用树：隐藏科研工作台自动创建的内部目录（学术研究/<项目>/00_课题与计划…06_投稿），
    // 这些目录由科研工作台管理，请到科研「空间」里查看；原始 folders 仍用于 API 操作/名称查找。
    const visibleFolders = useMemo(() => filterResearchFolders(folders), [folders]);

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

    // Keep the status/name cache in sync with whatever the list/detail show;
    // the poll uses the previous entry to detect a real terminal transition.
    useEffect(() => {
        for (const v of videos) {
            lastVectorStatusRef.current.set(v.uploadUuid, v.vectorStatus);
            fileNameRef.current.set(v.uploadUuid, v.title || v.originalName || "文件");
        }
        if (detail) {
            lastVectorStatusRef.current.set(detail.uploadUuid, detail.vectorStatus);
            fileNameRef.current.set(
                detail.uploadUuid,
                detail.title || detail.originalName || "文件"
            );
        }
    }, [videos, detail]);

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

    // ── cloud_refs 引用加载（按 folderId 合并进列表；失败静默空表）──
    const refreshRefs = useCallback(async (folderId: number | null) => {
        try {
            const res = await cloudApi.listRefs(folderId);
            setRefs(res.refs);
        } catch {
            setRefs([]);
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

    // Reload refs when folder changes (引用跟随所在文件夹).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshRefs(selectedFolderId);
    }, [selectedFolderId, refreshRefs]);

    // Invalidate the persisted folder if it was deleted elsewhere (e.g. in
    // another tab) so we don't sit on a stale id with an empty file list.
    useEffect(() => {
        if (selectedFolderId == null || foldersLoading || folders.length === 0) return;
        // 用「侧栏可见树」判断：若上次打开的目录已被隐藏（科研内部目录），回到根目录。
        if (findFolderName(visibleFolders, selectedFolderId) == null) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSelectedFolderId(null);
        }
    }, [selectedFolderId, visibleFolders, folders.length, foldersLoading]);

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
                    const previousStatus = lastVectorStatusRef.current.get(uuid);
                    lastVectorStatusRef.current.set(uuid, s.vectorStatus);
                    if (
                        previousStatus !== s.vectorStatus &&
                        !notifiedVectorRef.current.has(uuid) &&
                        (s.vectorStatus === "done" ||
                            s.vectorStatus === "failed" ||
                            s.vectorStatus === "not_supported")
                    ) {
                        notifiedVectorRef.current.add(uuid);
                        const fileName = fileNameRef.current.get(uuid) || "文件";
                        if (s.vectorStatus === "done") {
                            emitAppToast("success", "「" + fileName + "」已入库，可用于 AI 检索");
                        } else if (s.vectorStatus === "failed") {
                            emitAppToast("error", "「" + fileName + "」入库失败，请重试");
                        } else {
                            emitAppToast("warning", "「" + fileName + "」暂不支持入库（格式或内容无法解析）");
                        }
                    }
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
        setSelectedRefId(null);
    }, []);

    const handleSelectFile = useCallback((uuid: string) => {
        // Toggle semantics: clicking the selected file closes the inspector.
        // (Plain setSelectedUuid(uuid) on the same file would clear detail
        // while the [selectedUuid] effect skips refetch — a blank panel.)
        setSelectedUuid((prev) => (prev === uuid ? null : uuid));
        setDetail(null);
        setSelectedRefId(null);
    }, []);

    // 语义结果 / 相似文件可能不在当前文件夹列表里：详情接口按 uuid 独立加载，
    // 因此直接打开详情面板即可（不依赖列表项存在）。
    const handleOpenFileDetail = useCallback((uuid: string) => {
        setSelectedUuid(uuid);
        setDetail(null);
        setSelectedRefId(null);
    }, []);

    // ── cloud_refs handlers（引用不进上传/ASR/向量化菜单）──
    const handleSelectRef = useCallback((id: number) => {
        // dead 引用在列表层已被置灰无活动入口；此处只处理 alive。
        setSelectedRefId((prev) => (prev === id ? null : id));
        setSelectedUuid(null);
        setDetail(null);
    }, []);

    const handlePreviewRef = useCallback(
        (id: number) => {
            router.push(`/cloud-drive/refs/${id}`);
        },
        [router],
    );

    const handleDeleteRef = useCallback(async () => {
        const target = deleteRefTarget;
        if (!target) return;
        setBusyAction(true);
        try {
            await cloudApi.deleteRef(target.id);
            setDeleteRefTarget(null);
            setRefs((prev) => prev.filter((r) => r.id !== target.id));
            if (selectedRefId === target.id) setSelectedRefId(null);
        } catch {
            // Keep dialog open on failure.
        } finally {
            setBusyAction(false);
        }
    }, [deleteRefTarget, selectedRefId]);

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
                const doneName = list.length === 1 ? "「" + list[0].name + "」" : list.length + " 个文件";
                emitAppToast("success", doneName + "上传完成，点击「入库」后可生成摘要并加入检索");
            } catch (e) {
                emitAppToast("error", e instanceof Error ? "上传失败：" + e.message : "上传失败，请重试");
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
            void cloudApi.listTrash().then((res) => setTrashCount(res.total)).catch(() => {});
        } catch {
            // Keep dialog open.
        } finally {
            setBusyAction(false);
        }
    }, [deleteFileUuid, selectedUuid, refreshFolders]);

    const handleProcess = useCallback(
        async (uuid: string) => {
            // Local idempotency guard: clicking 入库 repeatedly must not even
            // hit the API while the file is queued/running. The backend has a
            // second atomic guard for multi-tab/API races.
            const knownStatus = lastVectorStatusRef.current.get(uuid);
            if (knownStatus === "done") {
                // 已入库文件不再允许重复入库（界面已隐藏入口，这里兜底多标签页/竞态）。
                emitAppToast("info", "该文件已入库，无需重复入库");
                return;
            }
            if (
                processingUuids.has(uuid) ||
                knownStatus === "pending" ||
                knownStatus === "processing"
            ) {
                emitAppToast("info", "该文件正在入库中，请等待完成");
                return;
            }
            notifiedVectorRef.current.delete(uuid);
            lastVectorStatusRef.current.set(uuid, "processing");
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
                const name = fileNameRef.current.get(uuid) || "文件";
                emitAppToast("info", "已提交入库，正在处理「" + name + "」");
            } catch (e) {
                setProcessingUuids((prev) => {
                    const next = new Set(prev);
                    next.delete(uuid);
                    return next;
                });
                emitAppToast(
                    "error",
                    e instanceof Error ? "提交入库失败：" + e.message : "提交入库失败，请重试"
                );
            }
        },
        [processingUuids]
    );

    // ── app-cloud handlers ──
    useEffect(() => {
        void cloudApi.getQuota().then(setQuota).catch(() => {});
    }, []);

    // 搜索防抖（清空时由派生值恢复文件夹列表，见 effectiveSearchResults / semanticActive）。
    // 文件名模式沿用 /cloud/search；语义模式调 /cloud/search/semantic，
    // 语义后端不可用时只在结果区报错，文件名搜索不受影响。
    useEffect(() => {
        const q = searchQ.trim();
        if (!q) return;
        let cancelled = false;

        if (searchMode === "name") {
            const t = setTimeout(() => {
                setSearching(true);
                void cloudApi
                    .searchFiles(q)
                    .then((res) => {
                        if (!cancelled) setSearchResults(res.results);
                    })
                    .catch(() => {
                        if (!cancelled) setSearchResults([]);
                    })
                    .finally(() => {
                        if (!cancelled) setSearching(false);
                    });
            }, 350);
            return () => {
                cancelled = true;
                clearTimeout(t);
            };
        }

        const folderId = semanticOnlyFolder ? selectedFolderId : null;
        const key = `${q}::${folderId ?? "all"}`;
        const t = setTimeout(() => {
            setSemanticLoading(true);
            setSemanticError(null);
            void cloudApi
                .searchSemantic({ q, folderId, limit: 10 })
                .then((res) => {
                    if (cancelled) return;
                    setSemanticResults(res.results);
                    setSemanticKey(key);
                })
                .catch((e) => {
                    if (cancelled) return;
                    setSemanticResults([]);
                    setSemanticKey(key);
                    setSemanticError(e instanceof Error ? e.message : "语义检索失败");
                })
                .finally(() => {
                    if (!cancelled) setSemanticLoading(false);
                });
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [searchQ, searchMode, semanticOnlyFolder, selectedFolderId, semanticReloadKey]);

    const refreshTrash = useCallback(async () => {
        setTrashLoading(true);
        try {
            const res = await cloudApi.listTrash();
            setTrashItems(res.items);
            setTrashCount(res.total);
        } finally {
            setTrashLoading(false);
        }
    }, []);

    // 徽章常驻计数：挂载时轻量拉一次
    useEffect(() => {
        void cloudApi
            .listTrash()
            .then((res) => setTrashCount(res.total))
            .catch(() => {});
    }, []);

    const handleToggleTrash = useCallback(() => {
        setTrashOpen((v) => {
            if (!v) void refreshTrash();
            return !v;
        });
        setSearchQ("");
        setSearchResults(null);
    }, [refreshTrash]);

    const handleRestore = useCallback(async (uuid: string) => {
        await cloudApi.restoreTrash(uuid);
        await refreshTrash();
        await refreshVideos(selectedFolderId, 1, false);
        await refreshFolders();
    }, [refreshTrash, refreshVideos, selectedFolderId, refreshFolders]);

    const handlePurge = useCallback(async (uuid: string) => {
        await cloudApi.purgeTrashItem(uuid);
        await refreshTrash();
    }, [refreshTrash]);

    // ── Derived ──
    // 搜索词非空时显示搜索结果，清空（或纯空白）时回落到文件夹列表
    const trimmedSearchQ = searchQ.trim();
    const searchActive = trimmedSearchQ.length > 0;
    const semanticActive = searchActive && searchMode === "semantic";
    const effectiveSearchResults =
        searchActive && searchMode === "name" ? searchResults : null;
    // 语义结果的 key = 查询词 + 检索范围；不匹配说明请求还没回来（或环境已变）
    const semanticScopeKey = `${trimmedSearchQ}::${
        semanticOnlyFolder && selectedFolderId != null ? selectedFolderId : "all"
    }`;
    const semanticPending =
        semanticActive && (semanticLoading || semanticKey !== semanticScopeKey);
    const totalFiles = folders.reduce((sum, f) => sum + (f.videoCount || 0), 0) + videos.length;
    const currentFolderName =
        selectedFolderId == null
            ? "全部文件"
            : findFolderName(folders, selectedFolderId) ?? "文件夹";

    const closeInspector = useCallback(() => {
        setSelectedUuid(null);
        setDetail(null);
        setSelectedRefId(null);
    }, []);

    // 点击右侧详情面板以外的空白区域 / 按 Esc 关闭详情面板。
    // 交互控件（按钮/链接/输入框/侧栏/面板本身）内部的点击不触发关闭，
    // 因此点文件行仍是正常切换选中项。
    const handleBackgroundClick = useCallback(
        (e: MouseEvent<HTMLDivElement>) => {
            if (selectedUuid == null && selectedRefId == null) return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (
                target.closest(
                    "button, a, input, textarea, select, label, [role='button'], aside"
                )
            ) {
                return;
            }
            closeInspector();
        },
        [selectedUuid, selectedRefId, closeInspector]
    );

    useEffect(() => {
        if (selectedUuid == null && selectedRefId == null) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeInspector();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectedUuid, selectedRefId, closeInspector]);

    return (
        <div
            className="flex h-[calc(100dvh-3rem-3.75rem-env(safe-area-inset-bottom,0px))] overflow-hidden md:h-[calc(100dvh-3rem)]"
            onClick={handleBackgroundClick}
        >
            {/* 手机端文件夹抽屉遮罩（md 以上隐藏） */}
            {foldersOpen && (
                <div
                    className="fixed inset-0 z-30 bg-black/30 md:hidden"
                    onClick={() => setFoldersOpen(false)}
                />
            )}

            {/* Sidebar：手机端覆盖式抽屉，md 以上静态侧栏 */}
            <aside
                className={cn(
                    "fixed inset-y-0 left-0 z-40 w-72 border-r border-border-subtle bg-surface pt-12 pb-[calc(3.75rem+env(safe-area-inset-bottom,0px))] transition-transform duration-300 md:static md:z-auto md:w-64 md:shrink-0 md:pb-0 md:pt-0 md:translate-x-0",
                    foldersOpen ? "translate-x-0" : "-translate-x-full"
                )}
            >
                <FolderSidebar
                    folders={visibleFolders}
                    loading={foldersLoading}
                    selectedFolderId={selectedFolderId}
                    totalCount={videosLoading ? 0 : totalFiles}
                    onSelect={(id) => {
                        handleSelectFolder(id);
                        if (trashOpen) setTrashOpen(false);
                        setFoldersOpen(false);
                    }}
                    onCreateFolder={handleCreateFolder}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={setDeleteFolderTarget}
                    onShareFolder={(folder) => {
                        setFolderShareTarget(folder);
                        setShareOpen(true);
                    }}
                    quota={quota}
                    trashCount={trashCount}
                    trashOpen={trashOpen}
                    onToggleTrash={() => {
                        handleToggleTrash();
                        setFoldersOpen(false);
                    }}
                    onOpenResearchFiles={() => {
                        // 手机端：先收起文件夹抽屉，再打开只读弹层。
                        setFoldersOpen(false);
                        setResearchFilesOpen(true);
                    }}
                />
            </aside>

            {/* Main */}
            <main className="flex min-w-0 flex-1 flex-col bg-background">
                <UploadDropzone onFiles={(files) => void handleFiles(files)}>
                    <FileToolbar
                        title={currentFolderName}
                        onOpenFolders={() => setFoldersOpen(true)}
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
                        searchValue={searchQ}
                        onSearchChange={setSearchQ}
                        searchMode={searchMode}
                        onSearchModeChange={(mode) => {
                            setSearchMode(mode);
                            if (mode === "semantic") {
                                // 重新进入语义模式时清掉上一轮的错误/缓存 key，触发重新检索
                                setSemanticKey(null);
                                setSemanticError(null);
                            }
                        }}
                        semanticOnlyFolder={semanticOnlyFolder}
                        onSemanticOnlyFolderChange={setSemanticOnlyFolder}
                        semanticFolderDisabled={selectedFolderId == null}
                        canShare={selectedUuid != null}
                        onShareClick={() => setShareOpen(true)}
                    />
                    <div className="flex-1 overflow-y-auto">
                        {trashOpen ? (
                            trashLoading ? (
                                <FileListSkeleton />
                            ) : trashItems.length === 0 ? (
                                <p className="py-16 text-center text-[13px] text-tertiary">回收站是空的</p>
                            ) : (
                                <ul className="divide-y divide-border-subtle px-5">
                                    {trashItems.map((t) => (
                                        <li key={t.uploadUuid} className="flex items-center justify-between py-2.5">
                                            <div className="min-w-0">
                                                <p className="truncate text-[13px] text-foreground">{t.originalName}</p>
                                                <p className="text-[11px] text-tertiary">
                                                    {formatBytes(t.fileSize)}
                                                    {t.purgeAt
                                                        ? ` · ${new Date(t.purgeAt).toLocaleDateString()} 彻底删除`
                                                        : ""}
                                                </p>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2 text-[12px]">
                                                <button
                                                    type="button"
                                                    onClick={() => void handleRestore(t.uploadUuid)}
                                                    className="text-accent hover:underline"
                                                >
                                                    恢复
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void handlePurge(t.uploadUuid)}
                                                    className="text-red-500 hover:underline"
                                                >
                                                    彻底删除
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )
                        ) : semanticActive ? (
                            <SemanticResults
                                hits={semanticResults ?? []}
                                loading={semanticPending}
                                error={semanticError}
                                onlyFolder={semanticOnlyFolder && selectedFolderId != null}
                                onRetry={() => setSemanticReloadKey((k) => k + 1)}
                                onOpen={handleOpenFileDetail}
                            />
                        ) : effectiveSearchResults != null ? (
                            searching ? (
                                <FileListSkeleton />
                            ) : effectiveSearchResults.length === 0 ? (
                                <p className="py-16 text-center text-[13px] text-tertiary">没有匹配的文件</p>
                            ) : (
                                <FileList
                                    videos={effectiveSearchResults}
                                    selectedUuid={selectedUuid}
                                    onSelect={handleSelectFile}
                                    hasMore={false}
                                    loadingMore={false}
                                    onLoadMore={() => {}}
                                />
                            )
                        ) : videosLoading ? (
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
                                refs={refs}
                                selectedRefId={selectedRefId}
                                onSelectRef={handleSelectRef}
                                onDeleteRef={(id) => setDeleteRefTarget(refs.find((r) => r.id === id) ?? null)}
                            />
                        ) : (
                            <FileGrid
                                videos={videos}
                                selectedUuid={selectedUuid}
                                onSelect={handleSelectFile}
                                hasMore={hasMore}
                                loadingMore={loadingMore}
                                onLoadMore={() => void handleLoadMore()}
                                refs={refs}
                                selectedRefId={selectedRefId}
                                onSelectRef={handleSelectRef}
                                onDeleteRef={(id) => setDeleteRefTarget(refs.find((r) => r.id === id) ?? null)}
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
                {selectedRefId != null && !selectedUuid && (() => {
                    const refItem = refs.find((r) => r.id === selectedRefId);
                    if (!refItem) return null;
                    return (
                        <motion.aside
                            key="ref-inspector"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="fixed bottom-[calc(3.75rem+env(safe-area-inset-bottom,0px))] left-0 right-0 top-12 z-40 border-border-subtle bg-surface md:bottom-0 lg:static lg:z-auto lg:w-[26rem] lg:border-l xl:w-[28rem]"
                        >
                            <RefInspector
                                refItem={refItem}
                                onPreview={handlePreviewRef}
                                onDelete={() => setDeleteRefTarget(refItem)}
                                onBack={() => setSelectedRefId(null)}
                            />
                        </motion.aside>
                    );
                })()}
                {selectedUuid && (
                    <motion.aside
                        key="inspector"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className={cn(
                            "fixed bottom-[calc(3.75rem+env(safe-area-inset-bottom,0px))] left-0 right-0 top-12 z-40 border-border-subtle bg-surface md:bottom-0 lg:static lg:z-auto lg:w-[26rem] lg:border-l xl:w-[28rem]"
                        )}
                    >
                        {detail ? (
                            <FileInspector
                                detail={detail}
                                processing={processingUuids.has(detail.uploadUuid)}
                                onProcess={(uuid) => void handleProcess(uuid)}
                                onDelete={(uuid) => setDeleteFileUuid(uuid)}
                                onBack={() => setSelectedUuid(null)}
                                onOpenFile={handleOpenFileDetail}
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
                message="文件将移入回收站，30 天后自动彻底删除；期间可随时恢复。"
                confirmLabel="移入回收站"
                danger
                busy={busyAction}
                onConfirm={() => void handleDeleteFile()}
                onCancel={() => (busyAction ? undefined : setDeleteFileUuid(null))}
            />

            {/* Delete ref confirm（引用删除只动引用，不影响原文件/原文件夹） */}
            <ConfirmDialog
                open={deleteRefTarget !== null}
                title="删除引用？"
                message={
                    deleteRefTarget
                        ? "将移除引用「" + deleteRefTarget.name + "」。这不影响原文件和原文件夹。"
                        : ""
                }
                confirmLabel="删除引用"
                danger
                busy={busyAction}
                onConfirm={() => void handleDeleteRef()}
                onCancel={() => (busyAction ? undefined : setDeleteRefTarget(null))}
            />

            {/* Share dialog（文件 / 文件夹两种 target） */}
            <ShareDialog
                open={shareOpen}
                target={
                    folderShareTarget
                        ? { type: "folder", folderId: folderShareTarget.id }
                        : selectedUuid
                          ? { type: "file", uploadUuid: selectedUuid }
                          : null
                }
                fileName={
                    folderShareTarget
                        ? folderShareTarget.name
                        : (detail?.originalName ?? "文件")
                }
                onClose={() => {
                    setShareOpen(false);
                    setFolderShareTarget(null);
                }}
            />

            {/* 科研项目文件（只读）：复用 ProjectFilesPanel(readOnly)，关闭即卸载 */}
            <ResearchFilesDialog
                open={researchFilesOpen}
                onClose={() => setResearchFilesOpen(false)}
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

// ── 科研工作台内部目录过滤 ──
// 科研工作台会在云盘里自动创建「学术研究/<项目>/00_课题与计划…06_投稿」这类内部目录。
// 这些目录属于科研归档结构，由科研工作台管理，请到科研「空间」里查看；云盘侧栏不展示。
const RESEARCH_ROOT_FOLDER_NAME = "学术研究";
const RESEARCH_SUBFOLDER_PATTERN = /^0[0-6]_/;

function isResearchSubfolderName(name: string): boolean {
    return RESEARCH_SUBFOLDER_PATTERN.test(name);
}

/**
 * 返回侧栏可见的文件夹树（新对象，不修改原树）：
 * - 名称 === "学术研究" → 整棵子树隐藏；
 * - 名称匹配 /^0[0-6]_/（00_课题与计划 … 06_投稿）→ 整棵子树隐藏；
 * - 名称不匹配、但全部子目录都是上述科研目录 → 视为科研项目根目录，整棵子树隐藏
 *   （避免「学术研究」被手动改名/移到别处后仍暴露项目目录）。
 * 正常用户文件夹保持原样，仅递归过滤其子节点。
 */
function filterResearchFolders(folders: CloudFolderTreeItem[]): CloudFolderTreeItem[] {
    const visible: CloudFolderTreeItem[] = [];
    for (const folder of folders) {
        if (folder.name === RESEARCH_ROOT_FOLDER_NAME) continue;
        if (isResearchSubfolderName(folder.name)) continue;
        if (
            folder.children.length > 0 &&
            folder.children.every((child) => isResearchSubfolderName(child.name))
        ) {
            continue;
        }
        visible.push({ ...folder, children: filterResearchFolders(folder.children) });
    }
    return visible;
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
