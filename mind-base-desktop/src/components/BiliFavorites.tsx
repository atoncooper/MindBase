/**
 * 收藏夹浏览（参考 frontendv2/components/favorites 的设计）：
 *
 * 每个收藏夹是一张卡片行——图标块、标题、默认徽章、"N 个视频"元信息、
 * 旋转 chevron；点击在卡片内原地展开视频列表（发丝线分隔，纯 CSS 高度
 * 动画）。视频首次展开时懒加载，之后保留状态。
 */

import { useEffect, useState } from "react";
import { biliListFolderVideos, biliListFolders, biliVideoPages } from "../lib/bili";
import type { BiliFavoriteFolder, BiliVideoItem, BiliVideoDetail, BiliPageItem } from "../lib/bili";
import { deleteDocument, ingestPage, ingestVideo, listDocuments } from "../lib/ingest";
import type { DocumentRow, IngestEvent } from "../lib/ingest";
import { toErrorMessage } from "../lib/updater";
import { useToast } from "../lib/toast";

/** Folder glyph for the card icon tile. */
function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8L12.5 7H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

/** Chevron used as the expand affordance; rotates when open. */
function ChevronDownIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={open ? "fav-card__chevron fav-card__chevron--open" : "fav-card__chevron"}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Seconds → m:ss / h:mm:ss. */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Per-folder video list state, owned by the card so folders stay independent. */
interface FolderVideos {
  videos: BiliVideoItem[];
  totalCount: number;
  hasMore: boolean;
  nextPage: number;
}

function FolderCard({
  folder,
  defaultOpen = false,
}: {
  folder: BiliFavoriteFolder;
  /** The first folder auto-expands so videos are visible without a click. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<FolderVideos | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  // Bumped by 重试 to re-run the initial load.
  const [reloadTick, setReloadTick] = useState(0);

  /** Load page 1 on first expand (or retry); later expands reuse the data. */
  useEffect(() => {
    if (!open || (data !== null && error === "")) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void biliListFolderVideos(folder.mediaId, 1).then(
      (page) => {
        if (cancelled) return;
        setData({
          videos: page.videos,
          totalCount: page.totalCount,
          hasMore: page.hasMore,
          nextPage: 2,
        });
        setLoading(false);
      },
      (err) => {
        if (!cancelled) {
          setError(toErrorMessage(err));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, reloadTick, folder.mediaId]);

  async function loadMore(): Promise<void> {
    if (data === null || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await biliListFolderVideos(folder.mediaId, data.nextPage);
      setData({
        videos: [...data.videos, ...page.videos],
        totalCount: page.totalCount,
        hasMore: page.hasMore,
        nextPage: data.nextPage + 1,
      });
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className={open ? "fav-card fav-card--open" : "fav-card"}>
      <button
        type="button"
        className="fav-card__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={open ? "fav-card__icon fav-card__icon--open" : "fav-card__icon"}>
          <FolderIcon />
        </span>
        <span className="fav-card__text">
          <span className="fav-card__title-row">
            <span className="fav-card__title">{folder.title}</span>
            {folder.isDefault && <span className="fav-card__badge">默认</span>}
          </span>
          <span className="fav-card__meta">收藏夹</span>
        </span>
        <span className="fav-card__count">
          <span className="fav-card__count-num">{folder.mediaCount}</span>
          <span className="fav-card__count-label">视频</span>
        </span>
        <ChevronDownIcon open={open} />
      </button>

      {/* Pure-CSS height animation via the grid 0fr→1fr technique. */}
      <div className={open ? "fold fold--open" : "fold"} inert={!open}>
        <div className="fold__inner">
          <div className="vlist">
            {loading && <p className="vlist__note">加载视频…</p>}
            {!loading && error !== "" && (
              <div className="vlist__fail">
                <p className="vlist__error">{error}</p>
                <button
                  type="button"
                  className="button"
                  onClick={() => setReloadTick((tick) => tick + 1)}
                >
                  重试
                </button>
              </div>
            )}
            {!loading && error === "" && data !== null && data.videos.length === 0 && (
              <p className="vlist__note">该收藏夹暂无视频</p>
            )}
            {data !== null && data.videos.length > 0 && (
              <>
                <div className="vlist__meta">
                  <span className="vlist__meta-count">共 {data.totalCount} 个视频</span>
                  {data.videos.some((video) => video.invalid) && (
                    <span className="vlist__meta-invalid">
                      {data.videos.filter((video) => video.invalid).length} 个已失效
                    </span>
                  )}
                </div>
                <ul className="vlist__items">
                  {data.videos.map((video) => (
                    <VideoRow key={video.bvid !== "" ? video.bvid : `${video.title}-${video.durationSec}`} video={video} />
                  ))}
                </ul>
              </>
            )}
            {data !== null && data.hasMore && !loading && (
              <div className="vlist__more">
                <button
                  type="button"
                  className="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Chevron used on video rows. */
function RowChevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={open ? "vrow__chevron vrow__chevron--open" : "vrow__chevron"}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * 视频行（下钻第三级）：点击原地展开分P 列表（frontendv2 PageList 模式）。
 * 分P 数据按 bvid 懒加载并缓存；失效视频同样可展开查看。
 */
function VideoRow({ video }: { video: BiliVideoItem }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<BiliVideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open || detail !== null) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void biliVideoPages(video.bvid).then(
      (result) => {
        if (!cancelled) {
          setDetail(result);
          setLoading(false);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(toErrorMessage(err));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, detail, video.bvid, reloadTick]);

  return (
    <li>
      <button
        type="button"
        className={open ? "vrow vrow--btn vrow--open" : "vrow vrow--btn"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="vrow__cover-wrap">
          {video.cover !== "" ? (
            <img
              src={video.cover}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="vrow__cover"
            />
          ) : (
            <span className="vrow__cover vrow__cover--empty" aria-hidden="true" />
          )}
          {!video.invalid && (
            <span className="vrow__play" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.5v13l11-6.5-11-6.5z" />
              </svg>
            </span>
          )}
          {video.durationSec > 0 && (
            <span className="vrow__dur">{formatDuration(video.durationSec)}</span>
          )}
        </span>
        <span className="vrow__body">
          <span className={video.invalid ? "vrow__title vrow__title--invalid" : "vrow__title"}>
            {video.invalid ? "[失效] " : ""}
            {video.title}
          </span>
          <span className="vrow__sub">
            {video.invalid ? "视频已失效" : video.upperName}
          </span>
        </span>
        <RowChevron open={open} />
      </button>

      <div className={open ? "fold fold--open" : "fold"} inert={!open}>
        <div className="fold__inner fold__inner--nested">
          <div className="pages">
            {loading && <p className="vlist__note">加载分P…</p>}
            {!loading && error !== "" && (
              <div className="vlist__fail">
                <p className="vlist__error">{error}</p>
                <button
                  type="button"
                  className="button"
                  onClick={() => setReloadTick((tick) => tick + 1)}
                >
                  重试
                </button>
              </div>
            )}
            {!loading && error === "" && detail !== null && detail.pages.length === 0 && (
              <p className="vlist__note">该视频暂无分P 信息</p>
            )}
            {detail !== null && detail.pages.length > 0 && (
              <>
                {!video.invalid ? (
                  <IngestPanel bvid={video.bvid} pages={detail.pages} />
                ) : (
                  <ul className="pages__items">
                    {detail.pages.map((page) => (
                      <li key={page.cid} className="prow">
                        <span className="prow__index">P{page.index}</span>
                        <span className="prow__title">
                          {page.partTitle.trim() !== "" ? page.partTitle : `第 ${page.index} P`}
                        </span>
                        <span className="prow__duration">{formatDuration(page.durationSec)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Rust-side step markers → short Chinese labels for the progress line. */
const STEP_LABELS: Record<string, string> = {
  conclusion: "获取大纲",
  audio: "解析音频",
  asr: "云端转写",
  chunk: "语义切块",
  embed: "向量化",
  store: "入库",
};

/**
 * 单视频入库面板（分P 展开区）：懒加载该视频的入库记录，提供整视频
 * 入库/重新入库与删除向量操作，也支持逐分P 单独入库；通过 Channel 事件
 * 实时渲染逐页进度。v1 为单飞设计——任一次入库（整视频或单分P）进行中
 * 其余入库按钮禁用，Rust 侧无全局队列。
 */
function IngestPanel({ bvid, pages }: { bvid: string; pages: BiliPageItem[] }) {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  // True while the ingest-record list is loading (no ingest buttons yet).
  const [docsLoading, setDocsLoading] = useState(true);
  const [busyAll, setBusyAll] = useState(false);
  // Per-分P busy flags: set of page indexes currently ingesting.
  const [busyPages, setBusyPages] = useState<ReadonlySet<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");
  // Live progress of the in-flight ingest run (-1 pct = indeterminate stage).
  const [progress, setProgress] = useState<{ pct: number; label: string; sub: string } | null>(null);
  // Per-分P progress lines keyed by page index, plus a run header/footer.
  const [pageLines, setPageLines] = useState<Map<number, string>>(new Map());
  const [runNote, setRunNote] = useState("");
  const [docsTick, setDocsTick] = useState(0);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setDocsLoading(true);
    void listDocuments().then(
      (rows) => {
        if (!cancelled) {
          setDocs(rows.filter((row) => row.bvid === bvid));
          setDocsLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setDocs([]);
          setDocsLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bvid, docsTick]);

  const doneDocs = (docs ?? []).filter((row) => row.status === "done");
  const hasDocs = doneDocs.length > 0;
  // Page indexes that already have done vectors — used for per-row labels.
  const doneIndexes = new Set(doneDocs.map((row) => row.pageIndex));
  // Any single ingest run (all pages or one page) in flight → lock the fold.
  const anyBusy = busyAll || busyPages.size > 0;

  function applyEvent(event: IngestEvent, titles: Map<number, string>): void {
    if (event.type === "start") {
      setRunNote(`共 ${event.totalPages} 个分P`);
      setProgress({ pct: 0, label: "准备", sub: `共 ${event.totalPages} 个分P` });
      return;
    }
    if (event.type === "done") {
      setRunNote(`完成：成功 ${event.ok} / 失败 ${event.failed}`);
      setProgress({ pct: 100, label: "完成", sub: `成功 ${event.ok} / 失败 ${event.failed}` });
      return;
    }
    const label =
      event.type === "pageStart" ? event.pageTitle : (titles.get(event.index) ?? `P${event.index}`);
    if (event.type === "pageStart") titles.set(event.index, event.pageTitle);
    setPageLines((prev) => {
      const next = new Map(prev);
      switch (event.type) {
        case "pageStart":
          next.set(event.index, `${label}：开始`);
          break;
        case "pageStep": {
          const stepLabel = STEP_LABELS[event.step] ?? event.step;
          next.set(event.index, `${label}：${stepLabel}`);
          break;
        }
        case "asrWait":
          next.set(event.index, `${label}：云端转写中（${event.elapsedSecs}s）`);
          break;
        case "pageDone":
          next.set(
            event.index,
            `${label}：✓ ${event.chunks} 块${
              event.source === "basic_info" ? "（无音轨，已降级为标题+简介）" : ""
            }`,
          );
          break;
        case "pageFailed":
          next.set(event.index, `${label}：失败 — ${event.error}`);
          break;
      }
      return next;
    });
    // Update the live progress bar.
    switch (event.type) {
      case "pageStart":
        setProgress({ pct: 0, label: `P${event.index}`, sub: "开始" });
        break;
      case "pageStep": {
        const stepLabel = STEP_LABELS[event.step] ?? event.step;
        if (event.step.startsWith("asr · ")) {
          // Sub-stage (e.g. "下载嵌入式 Python 运行时…", "安装 dashscope SDK…",
          // "调用 Python ASR 脚本…") — indeterminate.
          setProgress({ pct: -1, label: event.step.slice(6), sub: "" });
        } else {
          setProgress({ pct: -1, label: stepLabel, sub: "" });
        }
        break;
      }
      case "asrWait":
        setProgress({
          pct: Math.min(95, (event.elapsedSecs / 600) * 100),
          label: "云端转写中",
          sub: `${event.elapsedSecs}s`,
        });
        break;
      case "pageDone":
        setProgress({ pct: 100, label: `P${event.index} 完成`, sub: `${event.chunks} 块` });
        break;
      case "pageFailed":
        setProgress({ pct: -1, label: `P${event.index} 失败`, sub: event.error });
        break;
    }
  }

  /**
   * Start one ingestion run: the whole video when `pageIndex` is undefined,
   * otherwise only that single 分P. Fires a toast on failure so the user is
   * never left guessing that a page quietly failed.
   */
  async function runIngest(pageIndex?: number): Promise<void> {
    if (pageIndex === undefined ? busyAll : busyPages.has(pageIndex)) return;
    if (pageIndex === undefined) {
      setBusyAll(true);
    } else {
      setBusyPages((prev) => new Set(prev).add(pageIndex));
    }
    setActionError("");
    setPageLines(new Map());
    setRunNote("");
    // Collect per-page failures as they stream in, for the summary toast.
    const failures: string[] = [];
    try {
      const titles = new Map<number, string>();
      const onEvent = (event: IngestEvent) => {
        applyEvent(event, titles);
        if (event.type === "pageFailed") failures.push(`P${event.index} ${event.error}`);
      };
      const summary =
        pageIndex === undefined
          ? await ingestVideo(bvid, onEvent)
          : await ingestPage(bvid, pageIndex, onEvent);
      setRunNote(`完成：成功 ${summary.ok} / 失败 ${summary.failed}`);
      if (summary.failed > 0) {
        const reason = failures.slice(0, 3).join("；") + (failures.length > 3 ? "…" : "");
        const title = pageIndex === undefined ? "部分分P 入库失败" : `P${pageIndex} 入库失败`;
        toast.warning(
          `成功 ${summary.ok} / 失败 ${summary.failed}${reason ? `（${reason}）` : ""}`,
          { title, details: failures.length > 0 ? failures.join("\n") : undefined },
        );
      } else if (pageIndex !== undefined) {
        toast.success("该分P 已入库", { title: `P${pageIndex} 入库成功` });
      }
    } catch (err) {
      const message = toErrorMessage(err);
      setActionError(message);
      const title = pageIndex === undefined ? "入库失败" : `P${pageIndex} 入库失败`;
      toast.error(message, { title, details: message });
    } finally {
      if (pageIndex === undefined) {
        setBusyAll(false);
      } else {
        setBusyPages((prev) => {
          const next = new Set(prev);
          next.delete(pageIndex);
          return next;
        });
      }
      setDocsTick((tick) => tick + 1);
    }
  }

  async function removeVectors(): Promise<void> {
    if (deleting || !hasDocs || anyBusy) return;
    setDeleting(true);
    setActionError("");
    try {
      for (const doc of doneDocs) {
        await deleteDocument(doc.docId);
      }
    } catch (err) {
      setActionError(toErrorMessage(err));
    } finally {
      setDeleting(false);
      setDocsTick((tick) => tick + 1);
    }
  }

  const lines = [...pageLines.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);

  if (docsLoading) {
    return <p className="vlist__note">加载入库记录…</p>;
  }

  return (
    <div className="ingest">
      <ul className="pages__items">
        {pages.map((page) => {
          const pageBusy = busyPages.has(page.index);
          const pageDone = doneIndexes.has(page.index);
          return (
            <li key={page.cid} className="prow">
              <span className="prow__index">P{page.index}</span>
              <span className="prow__title">
                {page.partTitle.trim() !== "" ? page.partTitle : `第 ${page.index} P`}
              </span>
              <span className="prow__duration">{formatDuration(page.durationSec)}</span>
              <button
                type="button"
                className={pageDone ? "button prow__ingest" : "button button--primary prow__ingest"}
                disabled={anyBusy || deleting}
                title={pageDone ? "重新抓取该分P 并覆盖已有向量（消耗 ASR/Embedding 配额）" : "单独入库该分P"}
                onClick={() => void runIngest(page.index)}
              >
                {pageBusy ? (
                  <>
                    <span className="ingest__spinner" />入库中
                  </>
                ) : pageDone ? (
                  "重新入库"
                ) : (
                  "入库"
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="ingest__head">
        <span className="hint-text">
          {hasDocs
            ? `已入库 ${doneDocs.length}/${pages.length} 分P`
            : `未入库 · 共 ${pages.length} 分P`}
        </span>
        <span className="ingest__actions">
          <button
            type="button"
            className={hasDocs ? "button" : "button button--primary"}
            disabled={anyBusy || deleting}
            title={hasDocs ? "重新抓取并覆盖已有向量（消耗 ASR/Embedding 配额）" : "将该视频所有分P 依次入库"}
            onClick={() => void runIngest()}
          >
            {busyAll ? (
              <>
                <span className="ingest__spinner" />入库中
              </>
            ) : hasDocs ? (
              "重新入库"
            ) : (
              "全部入库"
            )}
          </button>
          {hasDocs && (
            <button
              type="button"
              className="button"
              disabled={anyBusy || deleting}
              onClick={() => void removeVectors()}
            >
              {deleting ? "删除中…" : "删除向量"}
            </button>
          )}
        </span>
      </div>
      {anyBusy && (
        <div className="ingest__busy" role="status" aria-live="polite">
          <div
            className={`ingest__bar ${
              progress && progress.pct < 0 ? "ingest__bar--indeterminate" : ""
            }`}
          >
            {progress && progress.pct >= 0 && (
              <div className="ingest__bar__fill" style={{ width: `${progress.pct}%` }} />
            )}
          </div>
          <span className="ingest__busy__text">
            {progress
              ? `${progress.label}${progress.sub ? ` · ${progress.sub}` : ""}`
              : "正在处理音频（ASR 转写 / 上传可能较慢，请耐心等待）…"}
          </span>
        </div>
      )}
      {(lines.length > 0 || runNote !== "") && (
        <ul className="ingest__lines">
          {runNote !== "" && <li key="run">{runNote}</li>}
          {lines.map((text, i) => (
            <li key={`${i}-${text}`}>{text}</li>
          ))}
        </ul>
      )}
      {actionError !== "" && <p className="error-text">{actionError}</p>}
    </div>
  );
}

interface BiliFavoritesProps {
  /** Bumped when the account changes; reloads folders. */
  refreshToken: number;
}

function BiliFavorites({ refreshToken }: BiliFavoritesProps) {
  const [folders, setFolders] = useState<BiliFavoriteFolder[] | null>(null);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFolders(null);
    setError("");
    void biliListFolders().then(
      (list) => {
        if (!cancelled) {
          // Default folder first (backend also sorts; this guards older rows).
          setFolders([...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)));
        }
      },
      (err) => {
        if (!cancelled) setError(toErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshToken, reloadTick]);

  return (
    <div className="bili-fav">
      {folders === null && error === "" && <p className="placeholder">加载收藏夹…</p>}
      {error !== "" && (
        <div className="vlist__fail">
          <p className="vlist__error">{error}</p>
          <button
            type="button"
            className="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
          >
            重试
          </button>
        </div>
      )}
      {folders !== null &&
        (folders.length === 0 ? (
          <p className="placeholder">没有可浏览的收藏夹</p>
        ) : (
          <div className="fav-stack">
            {folders.map((folder, index) => (
              <FolderCard key={folder.mediaId} folder={folder} defaultOpen={index === 0} />
            ))}
          </div>
        ))}
    </div>
  );
}

export default BiliFavorites;
