"use client";

import { useEffect, useRef, useState } from "react";
import { Database, Trash2, X } from "lucide-react";
import {
  cloudApi, formatBytes,
  type CloudVideoDetailResponse,
  type CloudDocumentPreviewResponse,
  type CloudVideoItem,
} from "@/lib/api";
import { getFileIcon } from "./helpers";

const VECTOR_LABELS: Record<string, string> = {
  done: "已入库",
  processing: "入库中",
  pending: "待入库",
  failed: "失败",
  not_supported: "暂不支持",
};

const PREVIEW_PAGE_SIZE = 5000;

export default function FileDetailDrawer({
  video,
  onClose,
  onProcess,
  onDelete,
}: {
  video: CloudVideoItem | null;
  onClose: () => void;
  onProcess: (uploadUuid: string) => void;
  onDelete: (video: CloudVideoItem) => void;
}) {
  const [detail, setDetail] = useState<CloudVideoDetailResponse | null>(null);
  // Accumulate preview text across pages.
  const [previewText, setPreviewText] = useState<string>("");
  const [previewMeta, setPreviewMeta] = useState<{
    totalChars: number;
    nextOffset: number | null;
    hasMore: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewBoxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!video) {
      setDetail(null);
      setPreviewText("");
      setPreviewMeta(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const uuid = video.uploadUuid;
    setLoading(true);
    setError(null);
    setDetail(null);
    setPreviewText("");
    setPreviewMeta(null);

    (async () => {
      try {
        const [d, p] = await Promise.all([
          cloudApi.getVideoDetail(uuid).catch(() => null),
          cloudApi.getDocumentPreview(uuid, 0, PREVIEW_PAGE_SIZE).catch(() => null),
        ]);
        if (cancelled) return;
        setDetail(d);
        if (p) {
          setPreviewText(p.preview ?? "");
          setPreviewMeta({
            totalChars: p.totalChars ?? 0,
            nextOffset: p.nextOffset ?? null,
            hasMore: !!p.hasMore,
          });
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [video?.uploadUuid]);

  const handleLoadMore = async () => {
    if (!video || !previewMeta?.hasMore || previewMeta.nextOffset == null) return;
    setLoadingMore(true);
    try {
      const next = await cloudApi.getDocumentPreview(
        video.uploadUuid,
        previewMeta.nextOffset,
        PREVIEW_PAGE_SIZE,
      );
      setPreviewText((prev) => prev + (next.preview ?? ""));
      setPreviewMeta({
        totalChars: next.totalChars ?? previewMeta.totalChars,
        nextOffset: next.nextOffset ?? null,
        hasMore: !!next.hasMore,
      });
    } catch (e: any) {
      setError(e?.message || "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  };

  if (!video) return null;

  const icon = getFileIcon(video.mimeType);
  const status = VECTOR_LABELS[video.vectorStatus] ?? video.vectorStatus;
  const canProcess =
    video.vectorStatus !== "done" && video.vectorStatus !== "not_supported";

  const totalChars = previewMeta?.totalChars ?? 0;
  const loadedChars = previewText.length;

  return (
    <>
      <div className="cd-drawer-scrim" onClick={onClose} />
      <aside className="cd-drawer" role="dialog" aria-label="文件详情">
        <header className="cd-drawer-header">
          <div className="cd-drawer-icon" style={{ color: icon.color }}>
            <icon.Icon size={28} />
          </div>
          <div className="cd-drawer-title">
            <div className="cd-drawer-name" title={video.originalName}>
              {video.title || video.originalName}
            </div>
            <div className="cd-drawer-sub">{icon.label} · {formatBytes(video.fileSize)}</div>
          </div>
          <button
            type="button"
            className="cd-btn-icon"
            onClick={onClose}
            title="关闭"
            aria-label="关闭详情"
          >
            <X size={16} />
          </button>
        </header>

        <div className="cd-drawer-actions">
          {canProcess && (
            <button
              type="button"
              className="cd-btn cd-btn-primary"
              onClick={() => onProcess(video.uploadUuid)}
            >
              <Database size={14} />
              <span>入库</span>
            </button>
          )}
          <button
            type="button"
            className="cd-btn cd-btn-outline"
            onClick={() => onDelete(video)}
          >
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        </div>

        <div className="cd-drawer-section">
          <h3>基本信息</h3>
          <dl className="cd-drawer-meta">
            <dt>类型</dt><dd>{video.mimeType || "未知"}</dd>
            <dt>大小</dt><dd>{formatBytes(video.fileSize)}</dd>
            {video.duration != null && (
              <>
                <dt>时长</dt>
                <dd>{Math.round(video.duration / 60)} 分钟</dd>
              </>
            )}
            <dt>上传时间</dt>
            <dd>{new Date(video.createdAt).toLocaleString("zh-CN")}</dd>
            <dt>入库状态</dt><dd>{status}</dd>
            {detail?.folderName && (<><dt>所在文件夹</dt><dd>{detail.folderName}</dd></>)}
            {detail?.vectorChunkCount != null && (
              <><dt>切片数</dt><dd>{detail.vectorChunkCount}</dd></>
            )}
          </dl>
        </div>

        {detail?.description && (
          <div className="cd-drawer-section">
            <h3>描述</h3>
            <p className="cd-drawer-desc">{detail.description}</p>
          </div>
        )}

        {detail?.tags && detail.tags.length > 0 && (
          <div className="cd-drawer-section">
            <h3>标签</h3>
            <div className="cd-drawer-tags">
              {detail.tags.map((t) => (
                <span key={t} className="cd-drawer-tag">{t}</span>
              ))}
            </div>
          </div>
        )}

        <div className="cd-drawer-section cd-drawer-preview">
          <h3>
            内容预览
            {totalChars > 0 && (
              <span className="cd-drawer-preview-progress">
                {" "}{loadedChars.toLocaleString()} / {totalChars.toLocaleString()} 字
              </span>
            )}
          </h3>
          {loading ? (
            <p className="cd-drawer-preview-empty">加载中…</p>
          ) : error ? (
            <p className="cd-drawer-preview-empty">{error}</p>
          ) : previewText ? (
            <>
              <pre ref={previewBoxRef} className="cd-drawer-preview-text">
                {previewText}
              </pre>
              {previewMeta?.hasMore && (
                <button
                  type="button"
                  className="cd-btn cd-btn-outline cd-drawer-preview-more"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              )}
            </>
          ) : detail?.asrPreview ? (
            <pre className="cd-drawer-preview-text">{detail.asrPreview}</pre>
          ) : (
            <p className="cd-drawer-preview-empty">
              {video.vectorStatus === "done"
                ? "暂无文本预览"
                : "需要先完成入库才能查看预览"}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
