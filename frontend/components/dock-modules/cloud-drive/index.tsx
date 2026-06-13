"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Cloud, FolderPlus, Trash2, Upload, RefreshCw, Loader2,
  ChevronRight, FileText, HardDrive, Folder, Database, Search,
} from "lucide-react";
import {
  cloudApi, formatBytes,
  type CloudFolderTreeItem,
  type CloudVideoItem,
} from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";
import ErrorDisplay, { useErrorDisplay } from "@/components/ErrorDisplay";
import ConfirmDialog from "../confirm-dialog";
import FolderTreeNode from "./folder-tree";
import CloudDriveStyles from "./styles";
import CloudDriveToolbar, {
  type SortDir, type SortField, type ViewMode,
} from "./toolbar";
import FileDetailDrawer from "./file-detail-drawer";
import CloudDriveBulkBar from "./bulk-action-bar";
import { findFolderPath, getFileIcon } from "./helpers";

const VIEW_KEY = "cloud-drive:view";
const SORT_KEY = "cloud-drive:sort";

function loadViewPref(): ViewMode {
  if (typeof window === "undefined") return "list";
  const v = window.localStorage.getItem(VIEW_KEY);
  return v === "grid" ? "grid" : "list";
}

function loadSortPref(): { field: SortField; dir: SortDir } {
  if (typeof window === "undefined") return { field: "date", dir: "desc" };
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (!raw) return { field: "date", dir: "desc" };
    const parsed = JSON.parse(raw) as { field?: SortField; dir?: SortDir };
    const field: SortField =
      parsed.field === "name" || parsed.field === "size" || parsed.field === "date"
        ? parsed.field
        : "date";
    const dir: SortDir = parsed.dir === "asc" ? "asc" : "desc";
    return { field, dir };
  } catch {
    return { field: "date", dir: "desc" };
  }
}

export default function CloudDrivePanel({ isOpen }: DockPanelProps) {
  // Folder tree
  const [folders, setFolders] = useState<CloudFolderTreeItem[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  // Selection
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  // Video list
  const [videos, setVideos] = useState<CloudVideoItem[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [videoPage, setVideoPage] = useState(1);
  const [videoHasMore, setVideoHasMore] = useState(false);

  // Create folder
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingParentId, setCreatingParentId] = useState<number | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "folder" | "video";
    id: number | string;
    name: string;
  } | null>(null);

  // Toast (success only — errors use ErrorDisplay)
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const { error, setError, clearError } = useErrorDisplay();

  // Toolbar state — search, sort, view mode (persisted)
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    setView(loadViewPref());
    const s = loadSortPref();
    setSortField(s.field);
    setSortDir(s.dir);
  }, []);

  const handleViewChange = (v: ViewMode) => {
    setView(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VIEW_KEY, v);
    }
  };

  const handleSortChange = (field: SortField, dir: SortDir) => {
    setSortField(field);
    setSortDir(dir);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SORT_KEY, JSON.stringify({ field, dir }));
    }
  };

  // Multi-select + drawer
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [drawerVideo, setDrawerVideo] = useState<CloudVideoItem | null>(null);
  const [bulkDeleteUuids, setBulkDeleteUuids] = useState<string[] | null>(null);

  const handleToggleSelect = (uploadUuid: string) => {
    setSelectedVideos((prev) => {
      const next = new Set(prev);
      if (next.has(uploadUuid)) next.delete(uploadUuid);
      else next.add(uploadUuid);
      return next;
    });
  };

  const handleClearSelection = () => setSelectedVideos(new Set());

  const handleDrawerOpen = (v: CloudVideoItem) => {
    setDrawerVideo(v);
  };

  const handleBulkProcess = async () => {
    const uuids = Array.from(selectedVideos);
    let done = 0;
    for (const uuid of uuids) {
      try {
        await cloudApi.triggerProcess(uuid);
        done++;
      } catch {
        // skip individual failures
      }
    }
    handleClearSelection();
    loadVideos(selectedFolderId, videoPage);
    showSuccess(`已触发 ${done}/${uuids.length} 个文件的入库任务`);
  };

  const handleBulkDeleteRequest = () => {
    if (selectedVideos.size === 0) return;
    setBulkDeleteUuids(Array.from(selectedVideos));
  };

  const handleBulkDeleteConfirm = async () => {
    const uuids = bulkDeleteUuids ?? [];
    let done = 0;
    for (const uuid of uuids) {
      try {
        await cloudApi.deleteVideo(uuid);
        done++;
      } catch {
        // skip individual failures
      }
    }
    handleClearSelection();
    showSuccess(`已删除 ${done}/${uuids.length} 个文件`);
    loadVideos(selectedFolderId, 1);
    loadFolders();
    setBulkDeleteUuids(null);
  };

  // Derived list — filter + sort. Operates on the loaded page; pagination
  // is server-driven so this is a client-side refinement, not a replacement.
  const visibleVideos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? videos.filter((v) =>
          (v.title || "").toLowerCase().includes(q) ||
          (v.originalName || "").toLowerCase().includes(q),
        )
      : videos.slice();

    const cmp = (a: CloudVideoItem, b: CloudVideoItem): number => {
      switch (sortField) {
        case "name": {
          const an = (a.title || a.originalName || "").toLowerCase();
          const bn = (b.title || b.originalName || "").toLowerCase();
          return an.localeCompare(bn, "zh-CN");
        }
        case "size":
          return (a.fileSize || 0) - (b.fileSize || 0);
        case "date":
        default: {
          const at = new Date(a.createdAt || 0).getTime();
          const bt = new Date(b.createdAt || 0).getTime();
          return at - bt;
        }
      }
    };
    filtered.sort((a, b) => (sortDir === "asc" ? cmp(a, b) : -cmp(a, b)));
    return filtered;
  }, [videos, searchQuery, sortField, sortDir]);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  /* ── Loaders ── */

  const loadFolders = useCallback(async () => {
    setFoldersLoading(true);
    try {
      const res = await cloudApi.listFolders();
      setFolders(res.folders || []);
    } catch (e: any) {
      if (!e.message?.includes("503")) setError(e);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  const loadVideos = useCallback(async (folderId: number | null, page: number) => {
    setVideosLoading(true);
    try {
      const res = await cloudApi.listVideos(folderId, page);
      if (page === 1) {
        setVideos(res.videos || []);
      } else {
        setVideos(prev => [...prev, ...(res.videos || [])]);
      }
      setVideoPage(page);
      setVideoHasMore(res.hasMore);
    } catch (e: any) {
      if (!e.message?.includes("503")) setError(e);
    } finally {
      setVideosLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadFolders();
      loadVideos(null, 1);
    }
  }, [isOpen, loadFolders, loadVideos]);

  // Plan 0023: WebSocket — real-time cloud processing status push
  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("bili_session") : null;
    if (!token) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = process.env.NEXT_PUBLIC_WS_URL || window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/ws/tasks?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {};
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== "cloud_processing") return;

        const { upload_uuid, status, chunk_count } = msg;
        setVideos((prev) =>
          prev.map((v) =>
            v.uploadUuid === upload_uuid
              ? { ...v, vectorStatus: status, vectorChunkCount: chunk_count ?? v.vectorChunkCount }
              : v
          )
        );
      } catch {
        // ignore non-JSON messages (heartbeats etc.)
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {};

    return () => { ws.close(); };
  }, [isOpen]);

  /* ── Handlers ── */

  const handleSelectFolder = (id: number | null) => {
    setSelectedFolderId(id);
    setVideos([]);
    setVideoPage(1);
    setVideoHasMore(false);
    loadVideos(id, 1);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await cloudApi.createFolder({ name: newFolderName.trim(), parentId: creatingParentId });
      setNewFolderName("");
      setCreatingFolder(false);
      setCreatingParentId(null);
      showSuccess("文件夹已创建");
      loadFolders();
    } catch (e: any) {
      setError(e);
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteTarget || deleteTarget.type !== "folder") return;
    try {
      await cloudApi.deleteFolder(deleteTarget.id as number);
      showSuccess("文件夹已删除");
      if (selectedFolderId === deleteTarget.id) {
        setSelectedFolderId(null);
        loadVideos(null, 1);
      }
      loadFolders();
    } catch (e: any) {
      setError(e);
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleDeleteVideo = async () => {
    if (!deleteTarget || deleteTarget.type !== "video") return;
    if (!deleteTarget.id) {
      setError(new Error("文件 ID 无效，请刷新页面后重试"));
      setDeleteTarget(null);
      return;
    }
    try {
      await cloudApi.deleteVideo(deleteTarget.id as string);
      showSuccess("文件已删除");
      loadVideos(selectedFolderId, 1);
      loadFolders();
    } catch (e: any) {
      setError(e);
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ALLOWED_MIME_PREFIXES = [
      "video/", "text/", "application/vnd.openxmlformats-officedocument.wordprocessingml",
      "application/pdf", "application/zip", "application/x-rar-compressed", "image/",
    ];
    const ALLOWED_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi|md|markdown|html?|docx?|txt|pdf|zip|rar|7z|png|jpe?g|gif|webp)$/i;
    const isAllowed = ALLOWED_MIME_PREFIXES.some(p => file.type.startsWith(p)) || ALLOWED_EXTENSIONS.test(file.name);
    if (!isAllowed) {
      setError(new Error("不支持的文件类型"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadFileName(file.name);

    try {
      await cloudApi.uploadFile(file, selectedFolderId, (pct) => {
        setUploadProgress(pct);
      });
      showSuccess(`"${file.name}" 上传完成`);
      loadVideos(selectedFolderId, 1);
      loadFolders();
    } catch (err: any) {
      setError(err);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleProcess = async (uploadUuid: string) => {
    try {
      await cloudApi.triggerProcess(uploadUuid);
      showSuccess("处理任务已触发");
      loadVideos(selectedFolderId, videoPage);
    } catch (e: any) {
      setError(e);
    }
  };

  const handleLoadMore = () => {
    if (videoHasMore && !videosLoading) {
      loadVideos(selectedFolderId, videoPage + 1);
    }
  };

  if (!isOpen) return null;

  /* ──── Status badge ──── */

  const renderStatus = (vec: string) => {
    const labels: Record<string, { text: string; cls: string }> = {
      done: { text: "已入库", cls: "cd-status-done" },
      processing: { text: "入库中", cls: "cd-status-proc" },
      pending: { text: "待入库", cls: "cd-status-pend" },
      failed: { text: "失败", cls: "cd-status-fail" },
      not_supported: { text: "暂不支持", cls: "cd-status-skip" },
    };
    const label = labels[vec] || { text: vec, cls: "" };

    return (
      <div className="cd-status-group">
        <span className={`cd-status-tag ${label.cls}`}>{label.text}</span>
      </div>
    );
  };

  return (
    <div className="cd-panel">
      {/* Toast */}
      {successMsg && (
        <div className="sk-toast success">{successMsg}</div>
      )}
      {error != null && (
        <ErrorDisplay error={error} variant="toast" onDismiss={clearError} />
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.type === "folder" ? "删除文件夹" : "删除文件"}
        message={`确定删除"${deleteTarget?.name ?? ""}"吗？此操作无法撤销。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={deleteTarget?.type === "folder" ? handleDeleteFolder : handleDeleteVideo}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Bulk-delete confirm */}
      <ConfirmDialog
        open={bulkDeleteUuids != null && bulkDeleteUuids.length > 0}
        title="批量删除文件"
        message={`确定删除选中的 ${bulkDeleteUuids?.length ?? 0} 个文件吗？此操作无法撤销。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleBulkDeleteConfirm}
        onCancel={() => setBulkDeleteUuids(null)}
      />

      {/* Header */}
      <div className="cd-header">
        <div className="cd-header-left">
          <Cloud size={18} />
          <h2>云盘</h2>
          <span className="cd-header-sub">上传文件构建知识库</span>
        </div>
        <div className="cd-header-actions">
          <button className="cd-btn cd-btn-outline" onClick={() => { loadFolders(); loadVideos(selectedFolderId, 1); }}>
            <RefreshCw size={14} />
            <span>刷新</span>
          </button>
          <button
            className="cd-btn cd-btn-primary"
            onClick={() => {
              setCreatingParentId(selectedFolderId);
              setCreatingFolder(true);
              setNewFolderName("");
            }}
          >
            <FolderPlus size={14} />
            <span>新建文件夹</span>
          </button>
          <button
            className="cd-btn cd-btn-accent"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            <span>{uploading ? `${uploadProgress}%` : "上传文件"}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleUpload}
            accept="video/*,.md,.html,.htm,.docx,.doc,.txt,.pdf,.zip,.rar,.png,.jpg,.jpeg,.gif,.webp"
          />
        </div>
      </div>

      {/* Upload progress bar */}
      {uploading && (
        <div className="cd-upload-bar-wrap">
          <div className="cd-upload-bar-track">
            <div className="cd-upload-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
          <span className="cd-upload-bar-label">
            {uploadFileName} — {uploadProgress}%
          </span>
        </div>
      )}

      {/* Create folder inline */}
      {creatingFolder && (
        <div className="cd-create-folder">
          <input
            className="cd-input"
            placeholder="文件夹名称"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setCreatingFolder(false); }}
            autoFocus
          />
          <button className="cd-btn cd-btn-primary" onClick={handleCreateFolder}>创建</button>
          <button className="cd-btn cd-btn-outline" onClick={() => setCreatingFolder(false)}>取消</button>
        </div>
      )}

      {/* Body: left tree + right list */}
      <div className="cd-body">
        {/* Left — folder tree */}
        <aside className="cd-sidebar">
          <div
            className={`cd-folder-row cd-folder-root ${selectedFolderId === null ? "cd-folder-row--active" : ""}`}
            onClick={() => handleSelectFolder(null)}
          >
            <HardDrive size={15} />
            <span>全部文件</span>
          </div>
          {foldersLoading ? (
            <div className="cd-loading"><Loader2 size={16} className="animate-spin" /></div>
          ) : folders.length === 0 ? (
            <div className="cd-empty-sidebar">暂无文件夹</div>
          ) : (
            folders.map((f) => (
              <FolderTreeNode
                key={f.id}
                folder={f}
                selectedId={selectedFolderId}
                depth={0}
                onSelect={handleSelectFolder}
                onDelete={(folder) => setDeleteTarget({ type: "folder", id: folder.id, name: folder.name })}
                onRefresh={() => { loadFolders(); loadVideos(selectedFolderId, 1); }}
              />
            ))
          )}
        </aside>

        {/* Right — file list */}
        <section className="cd-file-list">
          {/* Breadcrumb */}
          <nav className="cd-breadcrumb" aria-label="位置">
            <button
              className={`cd-crumb ${selectedFolderId === null ? "cd-crumb--active" : ""}`}
              onClick={() => handleSelectFolder(null)}
            >
              <HardDrive size={14} />
              <span>全部文件</span>
            </button>
            {findFolderPath(folders, selectedFolderId).map((node) => (
              <span key={node.id} className="cd-crumb-group">
                <ChevronRight size={14} className="cd-crumb-sep" />
                <button
                  className={`cd-crumb ${node.id === selectedFolderId ? "cd-crumb--active" : ""}`}
                  onClick={() => handleSelectFolder(node.id)}
                  title={node.name}
                >
                  <Folder size={14} />
                  <span>{node.name}</span>
                </button>
              </span>
            ))}
          </nav>

          {videosLoading && videos.length === 0 ? (
            <div className="cd-loading"><Loader2 size={20} className="animate-spin" /><span>加载中…</span></div>
          ) : videos.length === 0 ? (
            <div className="cd-empty">
              <FileText size={36} />
              <p>此文件夹暂无文件</p>
              <p className="cd-empty-sub">点击"上传文件"添加内容</p>
            </div>
          ) : (
            <>
              <CloudDriveToolbar
                query={searchQuery}
                onQueryChange={setSearchQuery}
                view={view}
                onViewChange={handleViewChange}
                sortField={sortField}
                sortDir={sortDir}
                onSortChange={handleSortChange}
              />
              {visibleVideos.length === 0 ? (
                <div className="cd-empty-search">
                  <Search size={28} />
                  <p>没有找到匹配"{searchQuery}"的文件</p>
                </div>
              ) : (
                <div className={`cd-video-grid ${view === "grid" ? "cd-video-grid--grid" : ""}`}>
                  {visibleVideos.map((v, i) => {
                    const isSelected = selectedVideos.has(v.uploadUuid);
                    return (
                    <div
                      key={v.uploadUuid || `video-${i}`}
                      className={`cd-video-card ${isSelected ? "cd-video-card--selected" : ""}`}
                      onClick={() => handleDrawerOpen(v)}
                      role="button"
                      tabIndex={0}
                    >
                      <input
                        type="checkbox"
                        className="cd-card-checkbox"
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => handleToggleSelect(v.uploadUuid)}
                        aria-label="选择文件"
                      />
                      <div className="cd-video-icon">
                        {(() => {
                          const fi = getFileIcon(v.mimeType);
                          return <fi.Icon size={28} color={fi.color} />;
                        })()}
                      </div>
                      <div className="cd-video-info">
                        <div className="cd-video-name" title={v.originalName}>
                          {v.title || v.originalName}
                        </div>
                        <div className="cd-video-meta">
                          <span className="cd-meta-type">{getFileIcon(v.mimeType).label}</span>
                          <span>{formatBytes(v.fileSize)}</span>
                          {v.duration != null && <span>{Math.round(v.duration / 60)} 分钟</span>}
                          <span>{new Date(v.createdAt).toLocaleDateString("zh-CN")}</span>
                        </div>
                        {renderStatus(v.vectorStatus)}
                      </div>
                      <div className="cd-video-actions" onClick={(e) => e.stopPropagation()}>
                        {v.vectorStatus !== "done" && v.vectorStatus !== "not_supported" && (
                          <button
                            className="cd-btn-icon"
                            title="入库"
                            onClick={() => handleProcess(v.uploadUuid)}
                          >
                            <Database size={14} />
                          </button>
                        )}
                        <button
                          className="cd-btn-icon cd-btn-icon-danger"
                          title="删除"
                          disabled={!v.uploadUuid}
                          onClick={() => {
                            if (!v.uploadUuid) return;
                            setDeleteTarget({ type: "video", id: v.uploadUuid, name: v.originalName });
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
              {videoHasMore && !searchQuery && (
                <button className="cd-btn cd-btn-outline cd-load-more" onClick={handleLoadMore} disabled={videosLoading}>
                  {videosLoading ? <Loader2 size={14} className="animate-spin" /> : null}
                  加载更多
                </button>
              )}
            </>
          )}
        </section>
      </div>

      <FileDetailDrawer
        video={drawerVideo}
        onClose={() => setDrawerVideo(null)}
        onProcess={(uuid) => {
          handleProcess(uuid);
        }}
        onDelete={(v) => {
          setDrawerVideo(null);
          setDeleteTarget({ type: "video", id: v.uploadUuid, name: v.originalName });
        }}
      />

      <CloudDriveBulkBar
        count={selectedVideos.size}
        onClear={handleClearSelection}
        onBulkProcess={handleBulkProcess}
        onBulkDelete={handleBulkDeleteRequest}
        processDisabled={false}
      />

      <CloudDriveStyles />
    </div>
  );
}
