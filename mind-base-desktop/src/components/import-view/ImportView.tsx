/**
 * 文件入库页（#/import）—— Google Drive 风格布局。
 *
 * 左列：添加内容卡（Drive 式拖放区 + 网页链接抓取）与入库队列卡（实时进度）；
 * 右列：入库记录（Drive 文件列表风格 + Google 式圆角搜索框），按类型着色的
 * 文件图标。后端预扫描（过滤扩展名/大小/上限）→ 确认队列 → 批量入库。
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
import { openResolvedLink } from "../../lib/linkify";
import { SearchGlyph } from "../icons";
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

/** 网址输入框的最大数量（防止一次抓取失控）。 */
const URL_INPUTS_MAX = 20;

/** 单行网址 → 规范化 URL（缺 https:// 自动补全）；无法成为网址时返回 null。 */
function normalizeUrlLine(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname;
    return host.includes(".") ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * 逐框解析网址输入：每个输入框最多一个网址。返回有效列表（去重）与
 * 无效/重复行的下标（供行内红字提示）。
 */
function parseUrlInputs(inputs: string[]): {
  valid: string[];
  invalidIdx: number[];
  duplicateIdx: number[];
} {
  const valid: string[] = [];
  const seen = new Set<string>();
  const invalidIdx: number[] = [];
  const duplicateIdx: number[] = [];
  inputs.forEach((input, index) => {
    const raw = input.trim();
    if (raw === "") return; // 空框不参与校验
    const candidate = normalizeUrlLine(raw);
    if (candidate === null) {
      invalidIdx.push(index);
      return;
    }
    if (seen.has(candidate)) {
      duplicateIdx.push(index);
      return;
    }
    seen.add(candidate);
    valid.push(candidate);
  });
  return { valid, invalidIdx, duplicateIdx };
}

/** Per-URL capture outcome for the status list under the textarea. */
interface CaptureResult {
  url: string;
  state: "pending" | "ok" | "failed";
  error?: string;
}

/** 网址输入框行首的链接 glyph（Material 链条形）。 */
function LinkGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.3 1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.3-1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Google Drive 产品图标：三色三角（蓝/绿/黄）。 */
function GoogleDriveIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0066da" d="M8.65 3 1.9 14.6l3.3 5.6L11.95 8.6z" />
      <path fill="#00ac47" d="M8.65 3h6.7l6.75 11.6h-6.7z" />
      <path fill="#ffba00" d="M5.2 20.2h13.6l3.3-5.6H8.5z" />
    </svg>
  );
}

/** 上传 glyph（Material 风格云上传，中性单色）。 */
function UploadGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M6.4 17.5a4.5 4.5 0 0 1-.9-8.9 5.5 5.5 0 0 1 10.7-1.1 4.2 4.2 0 0 1 1.6 8.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12.5V20" strokeLinecap="round" />
      <path d="m9 15.5 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 文件类型 → Drive 式着色分组。 */
type FileKind = "pdf" | "doc" | "img";

const FILE_KIND_COLORS: Record<FileKind, { fill: string; fold: string }> = {
  pdf: { fill: "#ea4335", fold: "#f6aea9" },
  doc: { fill: "#4285f4", fold: "#a6c8fa" },
  img: { fill: "#34a853", fold: "#a8dab5" },
};

function fileKindOf(ext: string): FileKind {
  const lowered = ext.toLowerCase();
  if (lowered === "pdf") return "pdf";
  if (OCR_IMAGE_EXTS.has(lowered)) return "img";
  return "doc";
}

/** Google Drive 式按类型着色的文件页图标（pdf 红 / 文档蓝 / 图片绿）。 */
function FileKindIcon({ ext }: { ext: string }): React.JSX.Element {
  const kind = fileKindOf(ext);
  const color = FILE_KIND_COLORS[kind];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill={color.fill} d="M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5L14.5 2z" />
      <path fill={color.fold} d="M14.5 2 19 6.5h-3.5a1 1 0 0 1-1-1V2z" />
      {kind === "img" ? (
        <>
          <circle cx="10" cy="12.6" r="1.1" fill="#fff" />
          <path fill="#fff" d="m9.1 17.8 2.3-2.7 1.8 2.1 1.3-1.5 2.6 3.1H9.1z" />
        </>
      ) : (
        <path
          fill="none"
          stroke="#fff"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M9 12h6M9 15h6M9 18h3.5"
        />
      )}
    </svg>
  );
}

/** 从路径取扩展名（无路径回退空串）。 */
function extOfPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function ImportView() {
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  // 网址输入框的值（每个输入框一个网址）；初始一个空框。
  const [urlInputs, setUrlInputs] = useState<string[]>([""]);
  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState("");
  // Per-URL outcomes of the latest capture run (pending rows tick over to
  // ok/failed as events arrive). Cleared when any input is edited.
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

  /** 编辑一个网址输入框；任何编辑都会让旧的抓取结果失效。 */
  function setUrlInputAt(index: number, value: string): void {
    setUrlInputs((prev) => prev.map((item, i) => (i === index ? value : item)));
    // Stale per-URL outcomes would mislead against edited input.
    if (captureResults.length > 0) setCaptureResults([]);
    if (captureNote !== "") setCaptureNote("");
  }

  /** 追加一个空网址框（达到上限后忽略）。 */
  function addUrlInput(): void {
    setUrlInputs((prev) => (prev.length >= URL_INPUTS_MAX ? prev : [...prev, ""]));
  }

  /** 移除一个网址框（至少保留一个）。 */
  function removeUrlInput(index: number): void {
    setUrlInputs((prev) => (prev.length <= 1 ? [""] : prev.filter((_, i) => i !== index)));
    if (captureResults.length > 0) setCaptureResults([]);
    if (captureNote !== "") setCaptureNote("");
  }

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
    const { valid } = parseUrlInputs(urlInputs);
    if (valid.length === 0) {
      setScanError("请输入至少一个有效网址（每个输入框一个网址）");
      return;
    }
    setCapturing(true);
    setScanError("");
    setCaptureNote("");
    setCaptureResults(valid.map((url) => ({ url, state: "pending" as const })));
    const failures: string[] = [];
    const captured: ScannedFile[] = [];
    try {
      const summary = await captureUrls(
        valid,
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
    <div className="imp-layout">
      <div className="imp-ops">
        <section className="card imp-panel">
          <div className="gen-hero">
            <span className="gen-hero__icon" aria-hidden="true">
              <GoogleDriveIcon />
            </span>
            <div className="gen-hero__text">
              <h2 className="gen-hero__title">文件入库</h2>
              <p className="gen-hero__sub">
                把本机文档与网页抓取进知识库——解析、分块、向量化一次完成。
              </p>
            </div>
          </div>

          <div className={dragging ? "imp-drop is-active" : "imp-drop"}>
            <span className="imp-drop__glyph" aria-hidden="true">
              <UploadGlyph />
            </span>
            <p className="imp-drop__title">将文件或文件夹拖到此处</p>
            <p className="imp-drop__or">或</p>
            <div className="imp-drop__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={scanning || running}
                onClick={() => void pickFiles()}
              >
                {scanning ? "扫描中…" : "选择文件"}
              </button>
              <button
                type="button"
                className="button"
                disabled={scanning || running}
                onClick={() => void pickFolder()}
              >
                {scanning ? "扫描中…" : "选择文件夹"}
              </button>
            </div>
          </div>
          {scanError !== "" && <p className="error-text">{scanError}</p>}
          <p className="hint-text imp-note">
            支持 txt / md / pdf / docx / html，以及图片 jpg / jpeg / png / bmp / webp
            （走本地 OCR 识别，需在「API 设置」中启用并下载模型；扫描版 PDF 无文本层时也会自动回退
            OCR）。递归扫描文件夹（跳过隐藏目录），单文件上限 50MB、单批 500
            个；内容重复的文件自动跳过（按内容指纹判重，改名/换位置也不重复入库）。首次导入 PDF /
            DOCX 时会自动下载解析依赖（pymupdf / python-docx）。入库后在「知识库」页检索、提问、出题。
          </p>

          <hr className="imp-divider" />

          <p className="gen-section-label">网页链接入库（每个输入框一个网址，抓取正文后进入下方队列）</p>
          <div className="url-fields">
            {(() => {
              // 逐框解析：给无效/重复的框挂上红框与提示（在渲染时计算即可）。
              const seen = new Set<string>();
              return urlInputs.map((value, index) => {
                const raw = value.trim();
                let invalidReason = "";
                if (raw !== "") {
                  const candidate = normalizeUrlLine(raw);
                  if (candidate === null) invalidReason = "无法识别，请检查网址格式";
                  else if (seen.has(candidate)) invalidReason = "与其他输入框重复";
                  else seen.add(candidate);
                }
                return (
                  <div
                    key={index}
                    className={invalidReason !== "" ? "url-field is-invalid" : "url-field"}
                    title={invalidReason !== "" ? invalidReason : undefined}
                  >
                    <span className="url-field__icon" aria-hidden="true">
                      <LinkGlyph />
                    </span>
                    <input
                      type="text"
                      className="url-field__input"
                      placeholder={index === 0 ? "如 https://example.com/article（不带协议的自动补全）" : "下一个网址…"}
                      value={value}
                      disabled={capturing || running}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(event) => setUrlInputAt(index, event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                          event.preventDefault();
                          if (!capturing && !running) void captureWebpages();
                        }
                        if (
                          event.key === "Enter" &&
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          // Enter = 添加下一个输入框（多网址连续录入）。
                          event.preventDefault();
                          if (!capturing && !running && urlInputs.length < URL_INPUTS_MAX) {
                            addUrlInput();
                          }
                        }
                      }}
                    />
                    {urlInputs.length > 1 && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="移除该网址"
                        title={invalidReason !== "" ? invalidReason : "移除"}
                        disabled={capturing || running}
                        onClick={() => removeUrlInput(index)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              });
            })()}
            {urlInputs.length < URL_INPUTS_MAX && (
              <button
                type="button"
                className="url-fields__add"
                disabled={capturing || running}
                onClick={addUrlInput}
              >
                ＋ 添加网址（最多 {URL_INPUTS_MAX} 个）
              </button>
            )}
          </div>
          {(() => {
            const { valid, invalidIdx, duplicateIdx } = parseUrlInputs(urlInputs);
            const failed = captureResults.filter((item) => item.state === "failed").length;
            const done = captureResults.filter((item) => item.state === "ok").length;
            const anyFilled = urlInputs.some((value) => value.trim() !== "");
            return (
              <p className="hint-text">
                {!anyFilled ? (
                  "每个输入框填写一个网址；缺 https:// 的会自动补全，Enter 快速添加下一框，Ctrl+Enter 直接抓取。"
                ) : (
                  <>
                    有效网址 {valid.length} 个
                    {invalidIdx.length > 0 && (
                      <span className="error-text">
                        {" "}
                        · {invalidIdx.length} 个无法识别（如「{urlInputs[invalidIdx[0]].trim()}」）
                      </span>
                    )}
                    {duplicateIdx.length > 0 && (
                      <span className="error-text"> · {duplicateIdx.length} 个重复</span>
                    )}
                    {captureResults.length > 0 && ` · 已完成 ${done}${failed > 0 ? `，失败 ${failed}` : ""}`}
                  </>
                )}
              </p>
            );
          })()}
          {captureResults.length > 0 && (
            <ul className="capture-list">
              {captureResults.map((item, index) => (
                <li key={`${index}-${item.url}`} className="capture-row">
                  <span className="capture-row__url" title={item.error ?? item.url}>
                    <a
                      className="text-link"
                      href={item.url}
                      title={item.error ?? `在浏览器打开 ${item.url}`}
                      onClick={(event) => {
                        event.preventDefault();
                        openResolvedLink(item.url);
                      }}
                    >
                      {item.url}
                    </a>
                  </span>
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
                </li>
              ))}
            </ul>
          )}
          <div className="card__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={capturing || running || parseUrlInputs(urlInputs).valid.length === 0}
              title="以浏览器请求头抓取网页并提取正文；被反爬拦截时会给出替代方案"
              onClick={() => void captureWebpages()}
            >
              {capturing ? (
                <>
                  <span className="ingest__spinner" />
                  抓取中 {captureResults.filter((item) => item.state !== "pending").length}/
                  {captureResults.length}
                </>
              ) : parseUrlInputs(urlInputs).valid.length > 0 ? (
                `抓取网页（${parseUrlInputs(urlInputs).valid.length}）`
              ) : (
                "抓取网页"
              )}
            </button>
            {captureNote !== "" && <span className="hint-text">{captureNote}</span>}
          </div>
        </section>

        {files !== null && (
          <section className="card imp-panel imp-queue">
            <h2 className="card__title">
              入库队列
              <span className="card__count">
                {total} 个文件 · {formatBytes(totalBytes)}
              </span>
            </h2>

            <ul className="file-list">
              {files.map((file, index) => {
                const run = runStates.get(index);
                return (
                  <li key={file.path} className="file-row">
                    <span className="file-row__icon" aria-hidden="true">
                      <FileKindIcon ext={file.ext} />
                    </span>
                    <span className="file-row__body">
                      <span className="file-row__name" title={file.path}>
                        {file.name}
                        {OCR_IMAGE_EXTS.has(file.ext) && (
                          <span className="ext-tag" title="该文件走本地 OCR 识别入库">
                            OCR
                          </span>
                        )}
                      </span>
                      <span
                        className="file-row__meta"
                        title={run !== undefined && run.state === "failed" ? run.detail : undefined}
                      >
                        {run !== undefined && run.detail !== "" ? run.detail : file.path}
                      </span>
                    </span>
                    <span className="file-row__actions">
                      <span className={run !== undefined ? runPill(run.state) : "status status--info"}>
                        {run !== undefined ? RUN_LABELS[run.state] : "待入库"}
                      </span>
                      {!running &&
                        (run === undefined || run.state === "pending" || run.state === "failed") && (
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
      </div>

      <section className="card imp-records">
        <h2 className="card__title">
          入库记录
          <span className="card__count">
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
          <div className="gsearch">
            <span className="gsearch__icon" aria-hidden="true">
              <SearchGlyph />
            </span>
            <input
              type="text"
              placeholder="搜索标题或路径…"
              value={recordQuery}
              onChange={(event) => setRecordQuery(event.target.value)}
            />
            {recordQuery !== "" && (
              <button
                type="button"
                className="icon-button"
                aria-label="清空搜索"
                title="清空"
                onClick={() => setRecordQuery("")}
              >
                ✕
              </button>
            )}
          </div>
        )}

        {records !== null && records.length === 0 && (
          <p className="hint-text">暂无文件入库记录。</p>
        )}
        {records !== null && records.length > 0 && filteredRecords !== null && filteredRecords.length === 0 && (
          <p className="hint-text">没有匹配「{recordQuery.trim()}」的记录。</p>
        )}
        {filteredRecords !== null && filteredRecords.length > 0 && (
          <ul className="file-list">
            {filteredRecords.map((row) => {
              const ext = extOfPath(row.filePath);
              return (
                <li key={row.docId} className="file-row">
                  <span className="file-row__icon" aria-hidden="true">
                    <FileKindIcon ext={ext} />
                  </span>
                  <span className="file-row__body">
                    <span className="file-row__name" title={row.filePath !== "" ? row.filePath : undefined}>
                      {row.videoTitle}
                    </span>
                    <span
                      className="file-row__meta"
                      title={row.status === "failed" && row.error !== "" ? row.error : undefined}
                    >
                      {row.chunkCount} 块 · {new Date(row.updatedAt * 1000).toLocaleString()}
                      {row.status === "failed" && row.error !== "" ? ` · ${row.error}` : ""}
                    </span>
                    {(row.url !== "" || row.filePath !== "") && (
                      <span className="file-row__links">
                        {row.url !== "" && (
                          <a
                            className="text-link"
                            href={row.url}
                            title={`在浏览器打开 ${row.url}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openResolvedLink(row.url);
                            }}
                          >
                            网页来源
                          </a>
                        )}
                        {row.filePath !== "" && (
                          <a
                            className="text-link"
                            href={row.filePath}
                            title={`打开 ${row.filePath}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openResolvedLink(row.filePath);
                            }}
                          >
                            本地文件
                          </a>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="file-row__actions">
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default ImportView;
