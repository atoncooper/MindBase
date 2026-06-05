"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Cloud, FolderPlus, Trash2, Upload, RefreshCw, Loader2,
  ChevronRight, ChevronDown, FileText, Play, HardDrive,
  Folder, FolderOpen,
} from "lucide-react";
import {
  cloudApi, formatBytes,
  type CloudFolderTreeItem, type CloudFolderResponse,
  type CloudVideoItem, type CloudVideoListResponse,
} from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";
import ErrorDisplay, { useErrorDisplay } from "@/components/ErrorDisplay";
import ConfirmDialog from "./confirm-dialog";

/* ──── Folder tree node ──── */

function FolderTreeNode({
  folder,
  selectedId,
  depth,
  onSelect,
  onDelete,
}: {
  folder: CloudFolderTreeItem;
  selectedId: number | null;
  depth: number;
  onSelect: (id: number | null) => void;
  onDelete: (folder: CloudFolderTreeItem) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = folder.children && folder.children.length > 0;

  return (
    <div className="cd-folder-group">
      <div
        className={`cd-folder-row ${selectedId === folder.id ? "cd-folder-row--active" : ""}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onSelect(folder.id)}
      >
        {hasChildren ? (
          <button
            className="cd-folder-chevron"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="cd-folder-chevron-placeholder" />
        )}
        <span className="cd-folder-icon">
          {selectedId === folder.id ? <FolderOpen size={15} /> : <Folder size={15} />}
        </span>
        <span className="cd-folder-name">{folder.name}</span>
        <span className="cd-folder-count">{folder.videoCount}</span>
        <button
          className="cd-folder-del"
          title="删除文件夹"
          onClick={(e) => { e.stopPropagation(); onDelete(folder); }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {hasChildren && expanded &&
        folder.children.map((child) => (
          <FolderTreeNode
            key={child.id}
            folder={child}
            selectedId={selectedId}
            depth={depth + 1}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))
      }
    </div>
  );
}

/* ──── Main ──── */

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

  const renderStatus = (asr: string, vec: string) => {
    const labels: Record<string, { text: string; cls: string }> = {
      done: { text: "已完成", cls: "cd-status-done" },
      processing: { text: "处理中", cls: "cd-status-proc" },
      pending: { text: "待处理", cls: "cd-status-pend" },
      failed: { text: "失败", cls: "cd-status-fail" },
    };
    const asrLabel = labels[asr] || { text: asr, cls: "" };
    const vecLabel = labels[vec] || { text: vec, cls: "" };

    return (
      <div className="cd-status-group">
        <span className={`cd-status-tag ${asrLabel.cls}`}>ASR {asrLabel.text}</span>
        <span className={`cd-status-tag ${vecLabel.cls}`}>向量 {vecLabel.text}</span>
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
        <div className="cd-upload-bar">
          <div className="cd-upload-bar-inner" style={{ width: `${uploadProgress}%` }} />
          <span className="cd-upload-bar-text">{uploadFileName} — {uploadProgress}%</span>
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
              />
            ))
          )}
        </aside>

        {/* Right — file list */}
        <section className="cd-file-list">
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
              <div className="cd-video-grid">
                {videos.map((v) => (
                  <div key={v.uploadUuid} className="cd-video-card">
                    <div className="cd-video-icon">
                      <FileText size={28} />
                    </div>
                    <div className="cd-video-info">
                      <div className="cd-video-name" title={v.originalName}>
                        {v.title || v.originalName}
                      </div>
                      <div className="cd-video-meta">
                        <span>{formatBytes(v.fileSize)}</span>
                        {v.duration != null && <span>{Math.round(v.duration / 60)} 分钟</span>}
                        <span>{new Date(v.createdAt).toLocaleDateString("zh-CN")}</span>
                      </div>
                      {renderStatus(v.asrStatus, v.vectorStatus)}
                    </div>
                    <div className="cd-video-actions">
                      {(v.asrStatus !== "done" || v.vectorStatus !== "done") && (
                        <button
                          className="cd-btn-icon"
                          title="触发处理"
                          onClick={() => handleProcess(v.uploadUuid)}
                        >
                          <Play size={14} />
                        </button>
                      )}
                      <button
                        className="cd-btn-icon cd-btn-icon-danger"
                        title="删除"
                        onClick={() => setDeleteTarget({ type: "video", id: v.uploadUuid, name: v.originalName })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {videoHasMore && (
                <button className="cd-btn cd-btn-outline cd-load-more" onClick={handleLoadMore} disabled={videosLoading}>
                  {videosLoading ? <Loader2 size={14} className="animate-spin" /> : null}
                  加载更多
                </button>
              )}
            </>
          )}
        </section>
      </div>

      <style jsx global>{`
        .cd-panel {
          height: 100%; flex: 1; display: flex; flex-direction: column; gap: 0;
          background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.08), transparent 28%),
                      linear-gradient(180deg, #161b22 0%, #21262d 100%);
          color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif;
          overflow: hidden;
        }
        .cd-header {
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding: 14px 18px; border-bottom: 1px solid rgba(48, 54, 61, 0.88);
          background: linear-gradient(180deg, rgba(33, 38, 45, 0.95) 0%, rgba(22, 27, 34, 0.92) 100%);
          flex-shrink: 0;
        }
        .cd-header-left { display: flex; align-items: center; gap: 8px; color: #06b6d4; }
        .cd-header-left h2 { font-size: 15px; font-weight: 700; color: #e2e8f0; margin: 0; }
        .cd-header-sub { font-size: 11.5px; color: #8b949e; margin-left: 4px; }
        .cd-header-actions { display: flex; align-items: center; gap: 8px; }

        .cd-btn {
          display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px;
          border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
          border: 1px solid transparent; transition: background .12s, border-color .12s, transform .12s;
        }
        .cd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .cd-btn-primary { border-color: rgba(6, 182, 212, 0.95); background: linear-gradient(180deg, #161b22 0%, #21262d 100%); color: #e2e8f0; }
        .cd-btn-primary:hover { background: rgba(6, 182, 212, 0.08); }
        .cd-btn-accent { background: rgba(6, 182, 212, 0.12); border-color: rgba(34, 211, 238, 0.4); color: #22d3ee; }
        .cd-btn-accent:hover { background: rgba(6, 182, 212, 0.2); border-color: #22d3ee; }
        .cd-btn-outline { border-color: rgba(48, 54, 61, 0.9); background: transparent; color: #8b949e; }
        .cd-btn-outline:hover { color: #e2e8f0; border-color: rgba(6, 182, 212, 0.2); }
        .cd-btn-icon { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 7px; border: 1px solid rgba(48, 54, 61, 0.85); background: transparent; color: #8b949e; cursor: pointer; transition: color .12s, background .12s; }
        .cd-btn-icon:hover { color: #e2e8f0; background: rgba(6, 182, 212, 0.08); }
        .cd-btn-icon-danger:hover { color: #f87171; background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.2); }

        .cd-input {
          padding: 7px 10px; border-radius: 7px; border: 1px solid rgba(48, 54, 61, 0.92);
          background: #161b22; color: #e2e8f0; font-size: 12.5px; outline: none; min-width: 180px;
        }
        .cd-input:focus { border-color: rgba(6, 182, 212, 0.6); }

        .cd-upload-bar {
          position: relative; height: 4px; background: rgba(48, 54, 61, 0.5); flex-shrink: 0;
        }
        .cd-upload-bar-inner {
          height: 100%; background: linear-gradient(90deg, #06b6d4, #22d3ee);
          transition: width .2s ease;
        }
        .cd-upload-bar-text {
          position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
          font-size: 11px; color: #22d3ee; white-space: nowrap;
        }

        .cd-create-folder {
          display: flex; align-items: center; gap: 8px; padding: 10px 18px;
          border-bottom: 1px solid rgba(48, 54, 61, 0.88); background: rgba(6, 182, 212, 0.04);
          flex-shrink: 0;
        }

        .cd-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }

        /* ── Sidebar ── */
        .cd-sidebar {
          width: 220px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid rgba(48, 54, 61, 0.88);
          padding: 8px 0;
        }
        .cd-folder-group {}
        .cd-folder-row {
          display: flex; align-items: center; gap: 5px; padding: 7px 10px; cursor: pointer;
          font-size: 13px; color: #c9d1d9; border-radius: 0;
          transition: background .1s, color .1s;
        }
        .cd-folder-row:hover { background: rgba(6, 182, 212, 0.06); color: #e2e8f0; }
        .cd-folder-row--active { background: rgba(6, 182, 212, 0.1); color: #22d3ee; font-weight: 600; }
        .cd-folder-row--active:hover { background: rgba(6, 182, 212, 0.14); }
        .cd-folder-root { font-weight: 600; padding: 9px 14px; border-bottom: 1px solid rgba(48, 54, 61, 0.5); }
        .cd-folder-chevron {
          display: flex; width: 16px; height: 16px; align-items: center; justify-content: center;
          background: none; border: none; color: inherit; cursor: pointer; padding: 0; flex-shrink: 0;
        }
        .cd-folder-chevron-placeholder { width: 16px; flex-shrink: 0; }
        .cd-folder-icon { display: flex; color: #8b949e; flex-shrink: 0; }
        .cd-folder-row--active .cd-folder-icon { color: #22d3ee; }
        .cd-folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cd-folder-count {
          font-size: 10.5px; padding: 1px 6px; border-radius: 999px;
          background: rgba(48, 54, 61, 0.6); color: #8b949e; font-weight: 600;
        }
        .cd-folder-del {
          display: none; background: none; border: none; color: #8b949e; cursor: pointer; padding: 2px;
        }
        .cd-folder-row:hover .cd-folder-del { display: flex; }
        .cd-folder-del:hover { color: #f87171; }

        .cd-empty-sidebar { padding: 20px; text-align: center; font-size: 12.5px; color: #8b949e; }
        .cd-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 28px; color: #8b949e; font-size: 13px; }

        /* ── File list ── */
        .cd-file-list {
          flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px;
        }
        .cd-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; color: #8b949e; }
        .cd-empty p { margin: 0; font-size: 14px; font-weight: 600; }
        .cd-empty-sub { font-size: 12px !important; font-weight: 400 !important; color: #8b949e !important; }

        .cd-video-grid { display: flex; flex-direction: column; gap: 8px; }
        .cd-video-card {
          display: flex; align-items: center; gap: 12px; padding: 12px 14px;
          border: 1px solid rgba(48, 54, 61, 0.88); border-radius: 12px;
          background: linear-gradient(180deg, #161b22 0%, #21262d 100%);
          transition: border-color .12s, background .12s;
        }
        .cd-video-card:hover { border-color: rgba(6, 182, 212, 0.15); background: rgba(6, 182, 212, 0.02); }
        .cd-video-icon { display: flex; color: #8b949e; flex-shrink: 0; }
        .cd-video-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .cd-video-name {
          font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: #e2e8f0;
        }
        .cd-video-meta { display: flex; gap: 10px; font-size: 11.5px; color: #8b949e; }
        .cd-status-group { display: flex; gap: 6px; margin-top: 2px; }
        .cd-status-tag {
          font-size: 10.5px; padding: 2px 6px; border-radius: 999px; font-weight: 600; white-space: nowrap;
        }
        .cd-status-done { background: rgba(16, 185, 129, 0.1); color: #4ade80; }
        .cd-status-proc { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
        .cd-status-pend { background: rgba(107, 114, 128, 0.1); color: #9ca3af; }
        .cd-status-fail { background: rgba(239, 68, 68, 0.1); color: #f87171; }
        .cd-video-actions { display: flex; gap: 2px; flex-shrink: 0; }
        .cd-load-more { align-self: center; margin-top: 4px; }

        /* Light mode */
        html:not(.dark) .cd-panel {
          background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.06), transparent 28%),
                      linear-gradient(180deg, var(--card) 0%, var(--paper) 100%);
          color: var(--foreground);
        }
        html:not(.dark) .cd-header { border-bottom-color: var(--border); background: linear-gradient(180deg, var(--paper) 0%, var(--card) 100%); }
        html:not(.dark) .cd-header-left h2 { color: var(--foreground); }
        html:not(.dark) .cd-input { background: var(--paper); border-color: var(--border); color: var(--foreground); }
        html:not(.dark) .cd-btn-primary { background: var(--card); color: var(--foreground); }
        html:not(.dark) .cd-btn-outline { color: var(--muted-foreground); }
        html:not(.dark) .cd-sidebar { border-right-color: var(--border); }
        html:not(.dark) .cd-folder-row { color: var(--foreground); }
        html:not(.dark) .cd-folder-row--active { color: var(--accent); }
        html:not(.dark) .cd-folder-count { background: var(--paper-3); }
        html:not(.dark) .cd-video-card { background: var(--card); border-color: var(--border); }
        html:not(.dark) .cd-video-card:hover { border-color: rgba(6, 182, 212, 0.2); }
        html:not(.dark) .cd-video-name { color: var(--foreground); }
        html:not(.dark) .cd-video-meta { color: var(--muted-foreground); }
        html:not(.dark) .cd-btn-icon { border-color: var(--border); color: var(--muted-foreground); }
        html:not(.dark) .cd-btn-icon:hover { color: var(--foreground); }
        html:not(.dark) .cd-loading, html:not(.dark) .cd-empty { color: var(--muted-foreground); }
        html:not(.dark) .cd-empty-sub { color: var(--muted-foreground) !important; }
        html:not(.dark) .cd-create-folder { background: rgba(6, 182, 212, 0.03); border-bottom-color: var(--border); }
        html:not(.dark) .cd-folder-root { border-bottom-color: var(--border); }
      `}</style>
    </div>
  );
}
