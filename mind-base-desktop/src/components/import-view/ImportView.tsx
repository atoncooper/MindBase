/**
 * 文件入库页：选择本机文件 / 文件夹 → 后端预扫描（过滤扩展名/大小/上限）
 * → 确认队列 → 批量入库（解析 → 切块 → 向量化）。
 *
 * 进度经 Tauri Channel 实时回推：队列里每个文件维护独立状态徽章
 * （等待 / 处理中 / 已入库 / 失败），总进度条按已完成文件数推进。
 * 与视频入库一致为单 flight：运行期间锁定所有入口按钮。
 */

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  IMPORT_EXTENSIONS,
  captureUrls,
  ingestFiles,
  scanImportPaths,
} from "../../lib/file-ingest";
import type {
  FileIngestEvent,
  FileIngestSummary,
  ScannedFile,
  WebCaptureEvent,
} from "../../lib/file-ingest";
import { deleteDocument, listDocuments } from "../../lib/ingest";
import type { DocumentRow } from "../../lib/ingest";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";
import { KNOWLEDGE_HASH, navigate } from "../../lib/router";

/** Per-file step labels, matching the video pipeline's vocabulary. */
const STEP_LABELS: Record<string, string> = {
  parse: "解析文本",
  ocr: "OCR 识别",
  chunk: "语义分块",
  embed: "向量化",
  store: "写入向量库",
};

/** Live state of one queued file during / after a run. */
interface FileRunState {
  state: "pending" | "running" | "done" | "skipped" | "failed";
  detail: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Status pill class for a queued file's live state. */
function runPill(state: FileRunState["state"]): string {
  switch (state) {
    case "done":
      return "status status--ok";
    case "failed":
      return "status status--error";
    case "running":
      return "status status--live";
    default:
      return "status status--info";
  }
}

const RUN_LABELS: Record<FileRunState["state"], string> = {
  pending: "等待",
  running: "处理中",
  done: "已入库",
  skipped: "重复跳过",
  failed: "失败",
};

/** Aggregate pill for the 入库记录 header line. */
function recordPill(status: DocumentRow["status"]): string {
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

const RECORD_STATUS_LABELS: Record<DocumentRow["status"], string> = {
  done: "已入库",
  failed: "失败",
  processing: "处理中",
  pending: "等待",
};

/** Extensions ingested through local OCR (keep in sync with file_ingest.rs). */
const OCR_IMAGE_EXTS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "bmp", "webp"]);

/** One parsed line of the URL textarea. */
interface ParsedUrl {
  /** Normalized URL (missing https:// is added automatically). */
  url: string;
  /** The raw line it came from, for pointing out invalid input. */
  raw: string;
}

/**
 * Parse the URL textarea: whitespace-separated (one per line recommended),
 * scheme auto-completed, deduped. Lines that cannot become a plausible URL
 * are returned separately so the UI can point at them.
 */
function parseUrlLines(text: string): { valid: ParsedUrl[]; invalid: string[] } {
  const valid: ParsedUrl[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\s+/).map((line) => line.trim()).filter((line) => line !== "")) {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    let host = "";
    try {
      host = new URL(candidate).hostname;
    } catch {
      host = "";
    }
    if (host.includes(".")) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        valid.push({ url: candidate, raw });
      }
    } else {
      invalid.push(raw);
    }
  }
  return { valid, invalid };
}

/** Per-URL capture outcome for the status list under the textarea. */
interface CaptureResult {
  url: string;
  state: "pending" | "ok" | "failed";
  error?: string;
}

function ImportView() {
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [urlText, setUrlText] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState("");
  // Per-URL outcomes of the latest capture run (pending rows tick over to
  // ok/failed as events arrive). Cleared when the textarea is edited.
  const [captureResults, setCaptureResults] = useState<CaptureResult[]>([]);
  const [running, setRunning] = useState(false);
  // Per-file live state keyed by queue index.
  const [runStates, setRunStates] = useState<Map<number, FileRunState>>(new Map());
  // Coarse current-activity label for the progress bar text.
  const [activity, setActivity] = useState("");
  const [summary, setSummary] = useState<FileIngestSummary | null>(null);
  // Ingestion records (file documents), reloaded after each run / delete.
  const [records, setRecords] = useState<DocumentRow[] | null>(null);
  const [recordsTick, setRecordsTick] = useState(0);
  const [busyRecordId, setBusyRecordId] = useState("");
  // docId of the record currently being re-ingested (inline retry).
  const [retryingId, setRetryingId] = useState("");
  // Drag & drop: dropping files/folders anywhere feeds the same scanner as
  // the picker buttons. `dragging` highlights the selection card.
  const [dragging, setDragging] = useState(false);
  // Latest busy state for the drop handler (avoids a stale closure inside
  // the once-registered drag listener).
  const busyRef = useRef(false);
  // Filter query for the 入库记录 list (matches title or path).
  const [recordQuery, setRecordQuery] = useState("");
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "leave") {
          setDragging(false);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          if (busyRef.current) return;
          if (event.payload.paths.length > 0) void scan(event.payload.paths);
        }
      })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listDocuments().then(
      (rows) => {
        if (!cancelled) setRecords(rows.filter((row) => row.sourceType === "file"));
      },
      () => {
        if (!cancelled) setRecords([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [recordsTick]);

  /** Expand a fresh selection (files or a folder) into the ingestible list. */
  async function scan(paths: string[]): Promise<void> {
    if (scanning || running) return;
    setScanning(true);
    setScanError("");
    try {
      const scanned = await scanImportPaths(paths);
      if (scanned.length === 0) {
        setScanError("所选位置没有可入库的文件");
        return;
      }
      setFiles(scanned);
      setRunStates(new Map());
      setActivity("");
      setSummary(null);
    } catch (err) {
      setScanError(toErrorMessage(err));
    } finally {
      setScanning(false);
    }
  }

  async function pickFiles(): Promise<void> {
    const selected = await open({
      multiple: true,
      title: "选择要入库的文件",
      filters: [{ name: "文档", extensions: [...IMPORT_EXTENSIONS] }],
    });
    const paths = (Array.isArray(selected) ? selected : selected ? [selected] : []).filter(
      (path): path is string => typeof path === "string",
    );
    if (paths.length > 0) void scan(paths);
  }

  async function pickFolder(): Promise<void> {
    const selected = await open({ directory: true, multiple: false, title: "选择要入库的文件夹" });
    if (typeof selected === "string" && selected.length > 0) void scan([selected]);
  }

  /**
   * Fetch web pages (one URL per line in the textarea) with browser-like
   * headers and push the saved HTML files into the ingest queue. Blocked
   * captures surface as per-URL failures with a manual-save suggestion.
   */
  async function captureWebpages(): Promise<void> {
    if (capturing || running) return;
    const { valid } = parseUrlLines(urlText);
    if (valid.length === 0) {
      setScanError("请输入至少一个有效网址（每行一个）");
      return;
    }
    setCapturing(true);
    setScanError("");
    setCaptureNote("");
    setCaptureResults(valid.map((entry) => ({ url: entry.url, state: "pending" as const })));
    const failures: string[] = [];
    const captured: ScannedFile[] = [];
    try {
      const summary = await captureUrls(
        valid.map((entry) => entry.url),
        (event: WebCaptureEvent) => {
          if (event.type === "urlDone") {
            captured.push({ path: event.path, name: event.name, size: event.bytes, ext: "html" });
            setCaptureResults((prev) =>
              prev.map((item, i) => (i === event.index ? { ...item, state: "ok" as const } : item)),
            );
          } else if (event.type === "urlFailed") {
            failures.push(`${event.index + 1}. ${event.error}`);
            setCaptureResults((prev) =>
              prev.map((item, i) =>
                i === event.index ? { ...item, state: "failed" as const, error: event.error } : item,
              ),
            );
          }
        },
      );
      if (captured.length > 0) {
        setFiles((prev) => {
          const seen = new Set((prev ?? []).map((file) => file.path));
          return [...(prev ?? []), ...captured.filter((file) => !seen.has(file.path))];
        });
        setRunStates(new Map());
        setActivity("");
        setSummary(null);
      }
      setCaptureNote(`抓取完成：成功 ${summary.ok} / 失败 ${summary.failed}${failures.length > 0 ? `（${failures[0]}）` : ""}`);
      if (summary.failed > 0) {
        const reason = failures.slice(0, 3).join("；") + (failures.length > 3 ? "…" : "");
        toast.warning(`成功 ${summary.ok} / 失败 ${summary.failed}${reason ? `（${reason}）` : ""}`, {
          title: "部分网页抓取失败",
          details: failures.length > 0 ? failures.join("\n") : undefined,
        });
      } else {
        toast.success(`已抓取 ${summary.ok} 个网页，点击「开始入库」完成向量化`, {
          title: "网页抓取完成",
        });
      }
    } catch (err) {
      const message = toErrorMessage(err);
      setScanError(message);
      toast.error(message, { title: "网页抓取失败" });
    } finally {
      setCapturing(false);
    }
  }

  function applyEvent(event: FileIngestEvent, names: Map<number, string>): void {
    const setRun = (index: number, state: FileRunState): void => {
      setRunStates((prev) => {
        const next = new Map(prev);
        next.set(index, state);
        return next;
      });
    };
    if (event.type === "start") {
      setActivity(`准备 · 共 ${event.total} 个文件`);
      return;
    }
    if (event.type === "done") {
      setActivity("");
      return;
    }
    const name =
      event.type === "fileStart" ? event.fileName : (names.get(event.index) ?? `文件 ${event.index + 1}`);
    if (event.type === "fileStart") names.set(event.index, event.fileName);
    switch (event.type) {
      case "fileStart":
        setRun(event.index, { state: "running", detail: "开始" });
        setActivity(`${name} · 开始`);
        break;
      case "fileStep": {
        const step = STEP_LABELS[event.step] ?? event.step;
        setRun(event.index, { state: "running", detail: step });
        setActivity(`${name} · ${step}`);
        break;
      }
      case "fileDone":
        setRun(event.index, { state: "done", detail: `${event.chunks} 块 / ${event.chars} 字` });
        setActivity(`${name} · 完成`);
        break;
      case "fileFailed":
        setRun(event.index, { state: "failed", detail: event.error });
        setActivity(`${name} · 失败`);
        break;
      case "fileSkipped":
        setRun(event.index, { state: "skipped", detail: event.reason });
        setActivity(`${name} · 跳过`);
        break;
    }
  }

  async function start(): Promise<void> {
    if (running || files === null || files.length === 0) return;
    setRunning(true);
    setSummary(null);
    // Every file starts as pending; events flip them to running/done/failed.
    const initial = new Map<number, FileRunState>();
    files.forEach((_, index) => initial.set(index, { state: "pending", detail: "" }));
    setRunStates(initial);
    // Collect per-file failures as they stream in, for the summary toast.
    const failures: string[] = [];
    try {
      const names = new Map<number, string>();
      const onEvent = (event: FileIngestEvent) => {
        applyEvent(event, names);
        if (event.type === "fileFailed") failures.push(`${event.index + 1}. ${event.error}`);
      };
      const result = await ingestFiles(
        files.map((file) => file.path),
        onEvent,
      );
      setSummary(result);
      if (result.failed > 0) {
        const reason = failures.slice(0, 3).join("；") + (failures.length > 3 ? "…" : "");
        toast.warning(`成功 ${result.ok} / 失败 ${result.failed}${reason ? `（${reason}）` : ""}`, {
          title: "部分文件入库失败",
          details: failures.length > 0 ? failures.join("\n") : undefined,
        });
      } else {
        toast.success(
          result.skipped > 0
            ? `已入库 ${result.ok} 个文件，跳过 ${result.skipped} 个重复`
            : `已入库 ${result.ok} 个文件`,
          { title: "文件入库完成" },
        );
      }
    } catch (err) {
      const message = toErrorMessage(err);
      setSummary({ ok: 0, failed: files.length, skipped: 0 });
      toast.error(message, { title: "文件入库失败", details: message });
    } finally {
      setRunning(false);
      setRecordsTick((tick) => tick + 1);
    }
  }

  async function removeRecord(docId: string): Promise<void> {
    if (busyRecordId !== "") return;
    setBusyRecordId(docId);
    try {
      await deleteDocument(docId);
      setRecordsTick((tick) => tick + 1);
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除失败" });
    } finally {
      setBusyRecordId("");
    }
  }

  /**
   * Re-ingest one failed record in place. The backend dedup only counts
   * done rows, so a failed row re-runs the full parse → embed pipeline;
   * if the content has meanwhile been ingested elsewhere it comes back as
   * a skip instead of consuming embedding quota.
   */
  async function retryRecord(row: DocumentRow): Promise<void> {
    if (running || retryingId !== "" || busyRecordId !== "") return;
    if (row.filePath === "") {
      toast.error("该记录缺少文件路径（旧版本入库），请删除后重新选择文件入库", {
        title: "无法重新入库",
      });
      return;
    }
    setRetryingId(row.docId);
    try {
      const result = await ingestFiles([row.filePath], () => {});
      if (result.ok > 0) {
        toast.success(`「${row.videoTitle}」已重新入库`, { title: "重新入库完成" });
      } else if (result.skipped > 0) {
        toast.success(`「${row.videoTitle}」内容已入库，已跳过`, { title: "重复跳过" });
      } else {
        toast.warning("重新入库失败，请查看记录中的错误信息", { title: "重新入库失败" });
      }
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "重新入库失败" });
    } finally {
      setRetryingId("");
      setRecordsTick((tick) => tick + 1);
    }
  }

  function removeFile(path: string): void {
    setFiles((prev) => (prev ? prev.filter((file) => file.path !== path) : prev));
  }

  const total = files?.length ?? 0;
  const finished = [...runStates.values()].filter(
    (run) => run.state === "done" || run.state === "skipped" || run.state === "failed",
  ).length;
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
  const totalBytes = (files ?? []).reduce((sum, file) => sum + file.size, 0);
  const anyStartable = files !== null && files.length > 0;
  busyRef.current = scanning || running || capturing;
  // Records filtered by the search box (title or path substring match).
  const query = recordQuery.trim().toLowerCase();
  const filteredRecords =
    records === null || query === ""
      ? records
      : records.filter(
          (row) =>
            row.videoTitle.toLowerCase().includes(query) ||
            row.filePath.toLowerCase().includes(query),
        );

  return (
    <>
      <section className={dragging ? "card dropzone is-active" : "card dropzone"}>
        <h2 className="card__title">
          <span className="card__index">01</span>选择要入库的内容
        </h2>

        <p className="hint-text">
        支持本机文档：txt / md / pdf / docx / html，以及图片 jpg / jpeg / png / bmp /
        webp（走本地 OCR 识别，需在「API 设置」中启用本地 OCR 并下载模型；扫描版
        PDF 无文本层时也会自动回退 OCR）。可选择多个文件或整个文件夹（递归扫描，
        跳过隐藏目录，单文件上限 50MB、单批上限 500 个），也可以直接把文件或文件夹
        <strong>拖拽到本页任意位置</strong>。入库后在「知识库」页检索、提问、出题。
        内容重复的文件自动跳过（按内容指纹判重，改名/换位置也不重复入库）；首次导入 PDF /
        DOCX 时会自动下载解析依赖（pymupdf / python-docx）。
        </p>

        <div className="card__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={scanning || running}
            onClick={() => void pickFiles()}
          >
            {scanning ? "扫描中…" : "选择文件"}
          </button>
          <button type="button" className="button" disabled={scanning || running} onClick={() => void pickFolder()}>
            {scanning ? "扫描中…" : "选择文件夹"}
          </button>
        </div>

        <label className="cfg-label" htmlFor="webpage-urls">
          网页链接入库（每行一个网址，抓取正文后进入下方队列）
        </label>
        <textarea
          id="webpage-urls"
          className="cfg-input"
          rows={3}
          placeholder={"https://example.com/article-one\nhttps://example.com/article-two\n（不带 https:// 也会自动补全）"}
          value={urlText}
          disabled={capturing || running}
          onChange={(event) => {
            setUrlText(event.target.value);
            // Stale per-URL outcomes would mislead against edited input.
            if (captureResults.length > 0) setCaptureResults([]);
            if (captureNote !== "") setCaptureNote("");
          }}
        />
        {(() => {
          const { valid, invalid } = parseUrlLines(urlText);
          const failed = captureResults.filter((item) => item.state === "failed").length;
          const done = captureResults.filter((item) => item.state === "ok").length;
          return (
            <p className="hint-text">
              {urlText.trim() === "" ? (
                "支持按行或空格分隔；缺 https:// 的网址会自动补全。"
              ) : (
                <>
                  有效网址 {valid.length} 个
                  {invalid.length > 0 && (
                    <span className="error-text"> · 无法识别 {invalid.length} 行（如「{invalid[0]}」）</span>
                  )}
                  {captureResults.length > 0 && ` · 已完成 ${done}${failed > 0 ? `，失败 ${failed}` : ""}`}
                </>
              )}
            </p>
          );
        })()}
        {captureResults.length > 0 && (
          <ul className="ws-docs">
            {captureResults.map((item, index) => (
              <li key={`${index}-${item.url}`} className="ws-doc">
                <div className="ws-doc__page">
                  <span className="ws-doc__page-meta" title={item.error ?? item.url}>
                    {item.url}
                  </span>
                  <span className="ws-doc__page-actions">
                    <span
                      className={
                        item.state === "ok"
                          ? "status status--ok"
                          : item.state === "failed"
                            ? "status status--error"
                            : "status status--live"
                      }
                    >
                      {item.state === "ok" ? "已抓取" : item.state === "failed" ? "失败" : "抓取中"}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="card__actions">
          <button
            type="button"
            className="button"
            disabled={capturing || running || parseUrlLines(urlText).valid.length === 0}
            title="以浏览器请求头抓取网页并提取正文；被反爬拦截时会给出替代方案"
            onClick={() => void captureWebpages()}
          >
            {capturing ? (
              <>
                <span className="ingest__spinner" />
                抓取中 {captureResults.filter((item) => item.state !== "pending").length}/
                {captureResults.length}
              </>
            ) : parseUrlLines(urlText).valid.length > 0 ? (
              `抓取网页（${parseUrlLines(urlText).valid.length}）`
            ) : (
              "抓取网页"
            )}
          </button>
          {captureNote !== "" && <span className="hint-text">{captureNote}</span>}
        </div>

        {scanError !== "" && <p className="error-text">{scanError}</p>}
      </section>

      {files !== null && (
        <section className="card">
          <h2 className="card__title">
            <span className="card__index">02</span>入库队列
            <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
              {total} 个文件 · {formatBytes(totalBytes)}
            </span>
          </h2>

          <ul className="ws-docs">
            {files.map((file, index) => {
              const run = runStates.get(index);
              return (
                <li key={file.path} className="ws-doc">
                  <div className="ws-doc__head">
                    <span className="ws-doc__title" title={file.path}>
                      {file.name}
                    </span>
                    <span className="ws-doc__page-meta">
                      {file.ext.toUpperCase()} · {formatBytes(file.size)}
                      {OCR_IMAGE_EXTS.has(file.ext) && (
                        <span className="ext-tag" title="该文件走本地 OCR 识别入库">
                          OCR
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="ws-doc__page">
                    <span
                      className="ws-doc__page-meta"
                      title={run !== undefined && run.state === "failed" ? run.detail : undefined}
                    >
                      {run !== undefined && run.detail !== "" ? run.detail : file.path}
                    </span>
                    <span className="ws-doc__page-actions">
                      <span className={run !== undefined ? runPill(run.state) : "status status--info"}>
                        {run !== undefined ? RUN_LABELS[run.state] : "待入库"}
                      </span>
                      {!running && (run === undefined || run.state === "pending" || run.state === "failed") && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="移除"
                          onClick={() => removeFile(file.path)}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          {running && (
            <div className="ingest__busy" role="status" aria-live="polite">
              <div className="ingest__bar">
                <div className="ingest__bar__fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="ingest__busy__text">
                {pct}% · {activity !== "" ? activity : "正在处理…"}
              </span>
            </div>
          )}

          {summary !== null && !running && (
            <div className="ingest__head">
              <span className={summary.failed === 0 ? "hint-text" : "error-text"}>
                入库完成：成功 {summary.ok}
                {summary.skipped > 0 ? ` · 重复跳过 ${summary.skipped}` : ""} · 失败{" "}
                {summary.failed}
              </span>
              <span className="ingest__actions">
                <button type="button" className="button" onClick={() => navigate(KNOWLEDGE_HASH)}>
                  前往知识库
                </button>
              </span>
            </div>
          )}

          <div className="card__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={running || retryingId !== "" || !anyStartable}
              title="开始解析并入库队列中的文件（消耗 Embedding 配额）"
              onClick={() => void start()}
            >
              {running ? (
                <>
                  <span className="ingest__spinner" />入库中
                </>
              ) : files !== null && files.some((_, index) => (runStates.get(index)?.state ?? "pending") === "done") ? (
                "重新入库全部"
              ) : (
                `开始入库（${total}）`
              )}
            </button>
            {!running && (
              <button type="button" className="button" onClick={() => setFiles(null)}>
                清空队列
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">03</span>入库记录
          <span
            className="hint-text"
            style={{ marginLeft: "auto", fontWeight: 400 }}
          >
            {records !== null
              ? query !== ""
                ? `${filteredRecords?.length ?? 0} / ${records.length} 个文件`
                : `${records.length} 个文件`
              : ""}
          </span>
        </h2>

        <p className="hint-text">
          本机文档的入库历史（视频在「知识库」页管理）。删除记录会同时清除其向量；删除后同一文件可重新入库。
        </p>

        {records !== null && records.length > 0 && (
          <input
            type="text"
            className="cfg-input cfg-input--narrow import-filter"
            placeholder="搜索标题或路径…"
            value={recordQuery}
            onChange={(event) => setRecordQuery(event.target.value)}
          />
        )}

        {records !== null && records.length === 0 && (
          <p className="hint-text">暂无文件入库记录。</p>
        )}
        {records !== null && records.length > 0 && filteredRecords !== null && filteredRecords.length === 0 && (
          <p className="hint-text">没有匹配「{recordQuery.trim()}」的记录。</p>
        )}
        {filteredRecords !== null && filteredRecords.length > 0 && (
          <ul className="ws-docs">
            {filteredRecords.map((row) => (
              <li key={row.docId} className="ws-doc">
                <div className="ws-doc__head">
                  <span className="ws-doc__title" title={row.filePath !== "" ? row.filePath : undefined}>
                    {row.videoTitle}
                  </span>
                  <span className="status status--info">{row.source.toUpperCase()} 文档</span>
                </div>
                <div className="ws-doc__page">
                  <span
                    className="ws-doc__page-meta"
                    title={row.status === "failed" && row.error !== "" ? row.error : undefined}
                  >
                    {row.chunkCount} 块 · {new Date(row.updatedAt * 1000).toLocaleString()}
                    {row.status === "failed" && row.error !== "" ? ` · ${row.error}` : ""}
                  </span>
                  <span className="ws-doc__page-actions">
                    <span className={recordPill(row.status)}>
                      {RECORD_STATUS_LABELS[row.status]}
                    </span>
                    {row.status === "failed" && (
                      <button
                        type="button"
                        className="button"
                        disabled={
                          running || retryingId !== "" || busyRecordId !== "" || busyRecordId === row.docId
                        }
                        title="重新解析并入库该文件"
                        onClick={() => void retryRecord(row)}
                      >
                        {retryingId === row.docId ? (
                          <>
                            <span className="ingest__spinner" />入库中
                          </>
                        ) : (
                          "重新入库"
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="删除记录"
                      disabled={busyRecordId === row.docId || retryingId !== ""}
                      onClick={() => void removeRecord(row.docId)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default ImportView;
