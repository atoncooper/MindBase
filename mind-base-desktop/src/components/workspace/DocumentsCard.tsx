/**
 * 工作区知识库卡：已入库文档列表（状态徽章 / 来源 / 分块数）+ 向量统计。
 * 删除操作同时清掉向量与元数据行；刷新按钮重新拉取。
 */

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { deleteDocument, listDocuments } from "../../lib/ingest";
import type { DocumentRow } from "../../lib/ingest";
import { getVectorStats } from "../../lib/vectors";
import type { VectorStats } from "../../lib/vectors";
import { toErrorMessage } from "../../lib/updater";

/** Status → pill class + glyph, matching the monochrome status language. */
function statusPill(status: DocumentRow["status"]): string {
  switch (status) {
    case "done":
      return "status status--ok";
    case "failed":
      return "status status--error";
    case "processing":
      return "status status--live";
    default:
      return "status status--info";
  }
}

const STATUS_LABELS: Record<DocumentRow["status"], string> = {
  done: "已入库",
  failed: "失败",
  processing: "处理中",
  pending: "等待",
};

const SOURCE_LABELS: Record<string, string> = {
  asr: "ASR 转写",
  basic_info: "标题+简介",
};

function DocumentsCard() {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [stats, setStats] = useState<VectorStats | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    void Promise.allSettled([listDocuments(), getVectorStats()]).then(
      ([docsResult, statsResult]) => {
        if (cancelled) return;
        if (docsResult.status === "fulfilled") setDocs(docsResult.value);
        else setError(toErrorMessage(docsResult.reason));
        if (statsResult.status === "fulfilled") setStats(statsResult.value);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  async function remove(docId: string): Promise<void> {
    if (busyId !== "") return;
    setBusyId(docId);
    try {
      await deleteDocument(docId);
      setReloadTick((tick) => tick + 1);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  // File documents (bvid empty) render as a flat list — they have no 分P
  // structure and no watch URL.
  const videoDocs = (docs ?? []).filter((doc) => doc.bvid !== "");
  const fileDocs = (docs ?? []).filter((doc) => doc.bvid === "");
  // Group video rows by video so one video with many 分P reads as a single block.
  const groups = new Map<string, DocumentRow[]>();
  for (const doc of videoDocs) {
    const list = groups.get(doc.bvid) ?? [];
    list.push(doc);
    groups.set(doc.bvid, list);
  }

  return (
    <section className="card">
      <h2 className="card__title">
        <span className="card__index">02</span>知识库
        <span
          className="hint-text"
          title={stats !== null ? stats.storagePath : undefined}
          style={{ marginLeft: "auto", fontWeight: 400 }}
        >
          {stats !== null ? `${stats.count} 个分块` : ""}
        </span>
      </h2>

      <div className="card__actions">
        <button
          type="button"
          className="button"
          onClick={() => setReloadTick((tick) => tick + 1)}
        >
          刷新
        </button>
      </div>

      {error !== "" && <p className="error-text">{error}</p>}
      {docs !== null && docs.length === 0 && error === "" && (
        <p className="hint-text">
          还没有入库内容。到「收藏夹」展开视频点「入库」，或到「文件入库」导入本机文档。
        </p>
      )}
      {fileDocs.length > 0 && (
        <ul className="ws-docs">
          {fileDocs.map((row) => (
            <li key={row.docId} className="ws-doc">
              <div className="ws-doc__head">
                <span className="ws-doc__title" title={row.filePath !== "" ? row.filePath : undefined}>
                  {row.videoTitle}
                </span>
                <span className="status status--info">{row.source.toUpperCase()} 文档</span>
              </div>
              <div className="ws-doc__page">
                <span className="ws-doc__page-meta">
                  {row.chunkCount} 块 · {new Date(row.updatedAt * 1000).toLocaleDateString()}
                  {row.status === "failed" && row.error !== "" ? ` · ${row.error}` : ""}
                </span>
                <span className="ws-doc__page-actions">
                  <span className={statusPill(row.status)}>{STATUS_LABELS[row.status]}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="删除向量"
                    disabled={busyId === row.docId}
                    onClick={() => void remove(row.docId)}
                  >
                    ✕
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {groups.size > 0 && (
        <ul className="ws-docs">
          {[...groups.entries()].map(([bvid, rows]) => {
            const head = rows[0];
            const doneCount = rows.filter((row) => row.status === "done").length;
            return (
              <li key={bvid} className="ws-doc">
                <div className="ws-doc__head">
                  <span className="ws-doc__title">{head.videoTitle}</span>
                  <span className={statusPallFor(rows, doneCount)}>{doneCount}/{rows.length} 分P</span>
                </div>
                <ul className="ws-doc__pages">
                  {rows.map((row) => (
                    <li key={row.docId} className="ws-doc__page">
                      <span className="ws-doc__page-title">
                        P{row.pageIndex}
                        {row.pageTitle !== "" ? ` · ${row.pageTitle}` : ""}
                      </span>
                      <span className="ws-doc__page-meta">
                        {SOURCE_LABELS[row.source] ?? row.source} · {row.chunkCount} 块 ·{" "}
                        {new Date(row.updatedAt * 1000).toLocaleDateString()}
                        {row.status === "failed" && row.error !== "" ? ` · ${row.error}` : ""}
                      </span>
                      <span className="ws-doc__page-actions">
                        <span className={statusPill(row.status)}>{STATUS_LABELS[row.status]}</span>
                        {row.url !== "" && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="打开视频"
                            onClick={() => void openUrl(row.url)}
                          >
                            ↗
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="删除向量"
                          disabled={busyId === row.docId}
                          onClick={() => void remove(row.docId)}
                        >
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Aggregate pill for the per-video header line. */
function statusPallFor(rows: DocumentRow[], doneCount: number): string {
  if (doneCount === rows.length) return "status status--ok";
  if (rows.some((row) => row.status === "processing")) return "status status--live";
  if (rows.some((row) => row.status === "failed")) return "status status--error";
  return "status status--info";
}

export default DocumentsCard;
