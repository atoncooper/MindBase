/**
 * 科研「文件」tab：左侧项目文件树 + 右侧预览（代码/文本、图片、PDF 逐页、DOCX HTML）。
 *
 * 代码高亮复用 mindmap 的 Prism 全局挂载（prismSetup 必须在语言组件之前导入），
 * 样式固定 VS Code Dark+ 深色（见 research.css .rs-code*），其余预览跟随 --rs-* 主题。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import Prism from "../mindmap/prismSetup";
import "prismjs/components/prism-python";
import "prismjs/components/prism-r";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-latex";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-csv";
import "prismjs/components/prism-toml";
import {
  getResearchFileDocxHtml, getResearchFileImage, getResearchFilePdfPage, importResearchFile,
  listResearchFiles, readResearchFile, resolveResearchFilePath,
  type ResearchFileEntry,
} from "../../lib/research-files";
import { copyToClipboard, errorText, formatDateTime } from "./common";
import { useToast } from "../../lib/toast";

/** 扩展名 → Prism 语法名（未列出的按纯文本展示）。 */
const CODE_LANG_BY_EXT: Record<string, string> = {
  py: "python", pyw: "python",
  r: "r",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", jsx: "jsx",
  json: "json",
  yaml: "yaml", yml: "yaml",
  tex: "latex", bib: "latex",
  md: "markdown", markdown: "markdown",
  csv: "csv",
  ini: "ini", cfg: "ini", conf: "ini", toml: "toml",
  html: "markup", htm: "markup", xml: "markup", svg: "markup",
  css: "css",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  java: "java", go: "go", rs: "rust", lua: "lua",
};

/** 纯文本（不高亮，但按文本预览）。 */
const TEXT_ONLY_EXTENSIONS = new Set(["txt", "log", "rst", "text", "gitignore"]);

/** 图片扩展名。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico"]);

type PreviewKind = "pdf" | "docx" | "image" | "text" | "binary";

/** 预览状态（单一状态机，避免切换文件时残留旧内容）。 */
type PreviewState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "text"; path: string; text: string; size: number; truncated: boolean; absolutePath: string }
  | { kind: "image"; path: string; dataUri: string; size: number }
  | { kind: "pdf"; path: string; dataUri: string; page: number; pageCount: number; dpi: number; loading: boolean }
  | { kind: "docx"; path: string; html: string; size: number }
  | { kind: "binary"; path: string; size: number; modifiedAt: number };

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
  children: TreeEntry[];
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index + 1).toLowerCase();
}

function previewKindOf(path: string): PreviewKind {
  const ext = extensionOf(path);
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (CODE_LANG_BY_EXT[ext] !== undefined || TEXT_ONLY_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

/** 文件图标（按扩展名给一个够用的 emoji，避免引入图标库）。 */
function fileIcon(name: string): string {
  const ext = extensionOf(name);
  if (ext === "py" || ext === "pyw") return "🐍";
  if (ext === "pdf") return "📕";
  if (IMAGE_EXTENSIONS.has(ext)) return "🖼";
  if (ext === "docx" || ext === "doc") return "📘";
  if (TEXT_ONLY_EXTENSIONS.has(ext) || ext === "md") return "📝";
  if (ext === "csv" || ext === "xlsx" || ext === "xls") return "📊";
  if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml" || ext === "ini") return "⚙";
  return "📄";
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + " " + units[index];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function languageForPath(path: string): string | null {
  const language = CODE_LANG_BY_EXT[extensionOf(path)];
  if (language === undefined) return null;
  return Prism.languages[language] === undefined ? null : language;
}

/** 单行 Prism 高亮；无语法 / 异常时退回转义纯文本。 */
function highlightLine(line: string, language: string | null): string {
  if (language !== null) {
    try {
      return Prism.highlight(line, Prism.languages[language], language);
    } catch {
      // fall through
    }
  }
  return escapeHtml(line);
}

function dataUriOf(base64: string, mime: string): string {
  if (base64.startsWith("data:")) return base64;
  return "data:" + (mime === "" ? "application/octet-stream" : mime) + ";base64," + base64;
}

/** DOCX HTML 纵深防御：剥掉脚本类节点与 on* / javascript: 属性。 */
function sanitizeDocxHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, link, meta, style").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        const isEvent = name.startsWith("on");
        const isScriptUrl = (name === "href" || name === "src" || name === "xlink:href") && value.startsWith("javascript:");
        if (isEvent || isScriptUrl) element.removeAttribute(attribute.name);
      }
    });
    return doc.body.innerHTML;
  } catch {
    return "";
  }
}

/** 把后端返回的扁平条目列表构建成目录树（隐式补齐中间目录）。 */
function buildTree(entries: ResearchFileEntry[]): TreeEntry[] {
  const root: TreeEntry = { name: "", path: "", isDir: true, size: 0, modifiedAt: 0, children: [] };
  const dirs = new Map<string, TreeEntry>([["", root]]);
  const ensureDir = (path: string): TreeEntry => {
    const existing = dirs.get(path);
    if (existing !== undefined) return existing;
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    const parent = ensureDir(segments.slice(0, -1).join("/"));
    const node: TreeEntry = { name, path, isDir: true, size: 0, modifiedAt: 0, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const entry of entries) {
    if (entry.path === "") continue;
    if (entry.isDir) {
      const node = ensureDir(entry.path);
      node.size = entry.size;
      node.modifiedAt = entry.modifiedAt;
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : entry.path.slice(0, slash));
    parent.children.push({
      name: entry.name === "" ? entry.path.slice(slash + 1) : entry.name,
      path: entry.path,
      isDir: false,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      children: [],
    });
  }
  const sortNodes = (nodes: TreeEntry[]): void => {
    nodes.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

/** 代码预览：Prism 高亮 + 行号 + 复制（VS Code 深色，样式见 research.css）。 */
function CodePreview({ text, path, truncated }: { text: string; path: string; truncated: boolean }): React.JSX.Element {
  const toast = useToast();
  const language = languageForPath(path);
  const highlighted = useMemo(() => {
    return text.split("\n").map((line) => (line === "" ? "" : highlightLine(line, language)));
  }, [text, language]);

  async function copyCode(): Promise<void> {
    const ok = await copyToClipboard(text);
    if (ok) toast.success("已复制代码", { title: "文件" });
    else toast.error("复制失败：剪贴板不可用", { title: "文件" });
  }

  return (
    <div className="rs-code">
      <div className="rs-code__bar">
        <span className="rs-code__lang">{language ?? "text"}</span>
        {truncated && <span className="rs-code__truncated">文件较大，仅显示前 2 MB</span>}
        <span className="spacer" />
        <button type="button" className="button rs-code__copy" onClick={() => void copyCode()}>复制代码</button>
      </div>
      <div className="rs-code__scroll">
        <pre className="rs-code__pre">
          {highlighted.map((line, index) => (
            <span className="rs-code__row" key={index}>
              <span className="rs-code__ln" aria-hidden="true">{index + 1}</span>
              <code className="rs-code__line" dangerouslySetInnerHTML={{ __html: line === "" ? "&#8203;" : line }} />
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default function FileTab({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [entries, setEntries] = useState<ResearchFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [pageInput, setPageInput] = useState("1");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const selectedPathRef = useRef<string | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? null;

  async function refreshFiles(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const rows = await listResearchFiles(projectId);
      setEntries(rows);
      setSelectedPath((prev) => (prev !== null && rows.some((entry) => entry.path === prev) ? prev : null));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** 选择任意本地文件复制进项目文件目录，刷新文件树并选中新文件。 */
  async function importFile(): Promise<void> {
    const selected = await open({ multiple: false, title: "导入文件到项目目录" });
    const source = (Array.isArray(selected) ? selected[0] : selected) ?? null;
    if (source === null || source === "") return;
    setImporting(true);
    setError(null);
    try {
      const entry = await importResearchFile(projectId, source);
      await refreshFiles();
      setSelectedPath(entry.path);
      toast.success("已导入 " + entry.name, { title: "导入文件" });
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "导入文件失败" });
    } finally {
      setImporting(false);
    }
  }

  /** 渲染一页 PDF（页面切换 / dpi 切换复用；用 ref 丢弃过期结果）。 */
  async function loadPdfPage(entry: ResearchFileEntry, page: number, dpi: number): Promise<void> {
    setPreview({ kind: "pdf", path: entry.path, dataUri: "", page, pageCount: 0, dpi, loading: true });
    try {
      const result = await getResearchFilePdfPage(projectId, entry.path, page, dpi);
      if (selectedPathRef.current !== entry.path) return;
      setPreview({
        kind: "pdf",
        path: entry.path,
        dataUri: dataUriOf(result.base64, result.mime),
        page: result.page,
        pageCount: result.pageCount,
        dpi,
        loading: false,
      });
    } catch (err) {
      if (selectedPathRef.current !== entry.path) return;
      setPreview({ kind: "error", path: entry.path, message: errorText(err) });
    }
  }

  useEffect(() => {
    selectedPathRef.current = selectedPath;
    setPageInput("1");
    if (selectedPath === null) { setPreview({ kind: "idle" }); return; }
    const entry = entries.find((row) => row.path === selectedPath);
    if (entry === undefined) { setPreview({ kind: "idle" }); return; }
    const kind = previewKindOf(entry.path);
    if (kind === "binary") {
      setPreview({ kind: "binary", path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt });
      return;
    }
    let cancelled = false;
    setPreview({ kind: "loading", path: entry.path });
    void (async () => {
      try {
        if (kind === "text") {
          const result = await readResearchFile(projectId, entry.path);
          if (cancelled) return;
          setPreview({
            kind: "text",
            path: result.path === "" ? entry.path : result.path,
            text: result.text,
            size: result.size,
            truncated: result.truncated,
            absolutePath: result.absolutePath,
          });
        } else if (kind === "image") {
          const result = await getResearchFileImage(projectId, entry.path);
          if (cancelled) return;
          setPreview({ kind: "image", path: entry.path, dataUri: dataUriOf(result.base64, result.mime), size: result.size });
        } else if (kind === "pdf") {
          await loadPdfPage(entry, 1, 144);
        } else {
          const result = await getResearchFileDocxHtml(projectId, entry.path);
          if (cancelled) return;
          setPreview({ kind: "docx", path: entry.path, html: sanitizeDocxHtml(result.html), size: result.size });
        }
      } catch (err) {
        if (!cancelled) setPreview({ kind: "error", path: entry.path, message: errorText(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, selectedPath, entries]);

  // PDF 页码变化时同步跳页输入框（loading 状态也同步，避免输入被旧值覆盖）。
  useEffect(() => {
    if (preview.kind === "pdf") setPageInput(String(preview.page));
  }, [preview]);

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectFile(path: string): void {
    setSelectedPath(path);
    setError(null);
  }

  async function copyRelativePath(): Promise<void> {
    if (selectedEntry === null) return;
    const ok = await copyToClipboard(selectedEntry.path);
    if (ok) toast.success("已复制相对路径", { title: "文件" });
    else setError("复制失败：当前环境剪贴板不可用");
  }

  async function openInSystem(): Promise<void> {
    if (selectedEntry === null) return;
    setError(null);
    try {
      const absolute = await resolveResearchFilePath(projectId, selectedEntry.path);
      await openPath(absolute);
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "打开失败" });
    }
  }

  async function goToPdfPage(page: number): Promise<void> {
    if (selectedEntry === null || preview.kind !== "pdf" || preview.loading) return;
    if (page < 1 || (preview.pageCount > 0 && page > preview.pageCount)) return;
    await loadPdfPage(selectedEntry, page, preview.dpi);
  }

  function jumpToPage(): void {
    if (preview.kind !== "pdf") return;
    const target = Math.floor(Number(pageInput));
    if (!Number.isFinite(target)) return;
    void goToPdfPage(target);
  }

  async function changeDpi(dpi: number): Promise<void> {
    if (selectedEntry === null || preview.kind !== "pdf") return;
    await loadPdfPage(selectedEntry, preview.page, dpi);
  }

  /** 文件树递归渲染（目录优先已由 buildTree 排序）。 */
  function renderNodes(nodes: TreeEntry[], depth: number): React.JSX.Element[] {
    return nodes.map((node) => {
      const indent = { paddingLeft: 8 + depth * 14 };
      if (node.isDir) {
        const open = expanded.has(node.path);
        return (
          <div key={"dir:" + node.path} className="rs-filetree__group" role="treeitem" aria-expanded={open}>
            <button type="button" className="rs-filetree__row rs-filetree__row--dir" style={indent} onClick={() => toggleDir(node.path)}>
              <span className={open ? "rs-filetree__chevron is-open" : "rs-filetree__chevron"} aria-hidden="true">▸</span>
              <span className="rs-filetree__icon" aria-hidden="true">{open ? "📂" : "📁"}</span>
              <span className="rs-filetree__name">{node.name}</span>
            </button>
            {open && node.children.length > 0 && <div role="group">{renderNodes(node.children, depth + 1)}</div>}
          </div>
        );
      }
      const active = node.path === selectedPath;
      return (
        <button
          key={"file:" + node.path}
          type="button"
          role="treeitem"
          aria-selected={active}
          title={node.path}
          className={active ? "rs-filetree__row is-active" : "rs-filetree__row"}
          style={indent}
          onClick={() => selectFile(node.path)}
        >
          <span className="rs-filetree__icon" aria-hidden="true">{fileIcon(node.name)}</span>
          <span className="rs-filetree__name">{node.name}</span>
          <span className="rs-filetree__size">{formatBytes(node.size)}</span>
        </button>
      );
    });
  }

  function renderPreview(): React.JSX.Element {
    switch (preview.kind) {
      case "idle":
        return <p className="hint-text">从左侧选择文件即可预览；代码支持高亮与行号，PDF 可逐页浏览。</p>;
      case "loading":
        return <p className="hint-text">读取中…</p>;
      case "error":
        return <p className="error-text">{preview.message}</p>;
      case "text":
        return <CodePreview text={preview.text} path={preview.path} truncated={preview.truncated} />;
      case "image":
        return (
          <div className="rs-image">
            <img src={preview.dataUri} alt={preview.path} />
          </div>
        );
      case "pdf":
        return (
          <div className="rs-pdf">
            <div className="rs-pdf__bar">
              <button
                type="button"
                className="button research-btn-sm"
                disabled={preview.loading || preview.page <= 1}
                onClick={() => void goToPdfPage(preview.page - 1)}
              >
                上一页
              </button>
              <span className="rs-pdf__pagebox">
                <input
                  className="text-input rs-pdf__pageinput"
                  type="number"
                  min={1}
                  max={preview.pageCount > 0 ? preview.pageCount : undefined}
                  value={pageInput}
                  aria-label="跳转到页码"
                  onChange={(event) => setPageInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") jumpToPage(); }}
                />
                <span className="rs-pdf__pagetotal">{"/ " + (preview.pageCount > 0 ? preview.pageCount : "?")}</span>
                <button type="button" className="button research-btn-sm" disabled={preview.loading} onClick={jumpToPage}>跳转</button>
              </span>
              <button
                type="button"
                className="button research-btn-sm"
                disabled={preview.loading || (preview.pageCount > 0 && preview.page >= preview.pageCount)}
                onClick={() => void goToPdfPage(preview.page + 1)}
              >
                下一页
              </button>
              <span className="spacer" />
              <label className="rs-pdf__dpi">
                DPI
                <select
                  className="research-select"
                  value={String(preview.dpi)}
                  disabled={preview.loading}
                  onChange={(event) => void changeDpi(Number(event.target.value))}
                >
                  <option value="96">96</option>
                  <option value="144">144</option>
                  <option value="192">192</option>
                </select>
              </label>
            </div>
            {preview.loading ? (
              <p className="hint-text">正在渲染 PDF 页面…</p>
            ) : preview.dataUri !== "" ? (
              <img className="rs-pdf__img" src={preview.dataUri} alt={"第 " + preview.page + " 页"} />
            ) : (
              <p className="hint-text">暂无页面图像。</p>
            )}
          </div>
        );
      case "docx":
        return (
          <>
            <div className="rs-docx" dangerouslySetInnerHTML={{ __html: preview.html }} />
            <p className="hint-text" style={{ marginTop: 8 }}>DOCX 已转换为只读 HTML 预览；需要精确排版请「用系统应用打开」。</p>
          </>
        );
      case "binary":
        return (
          <div className="rs-binary">
            <p>该文件是二进制或暂不支持预览的格式。</p>
            <p className="hint-text">{formatBytes(preview.size) + " · " + formatDateTime(preview.modifiedAt)}</p>
            <button type="button" className="button research-btn-sm" onClick={() => void openInSystem()}>用系统应用打开</button>
          </div>
        );
    }
  }

  return (
    <div className="rs-pane rs-files-page">
      {error !== null && <p className="error-text" style={{ margin: 0 }} onClick={() => setError(null)}>{error}</p>}

      <div className="rs-files">
        <div className="card rs-files__tree-card">
          <div className="research-section-head">
            <h3>项目文件</h3>
            <span className="hint-text">{loading ? "加载中…" : entries.length + " 项"}</span>
            <span className="spacer" />
            <button type="button" className="button research-btn-sm" disabled={importing} onClick={() => void importFile()}>
              {importing ? "导入中…" : "导入文件"}
            </button>
            <button type="button" className="button research-btn-sm" disabled={loading} onClick={() => void refreshFiles()}>
              刷新
            </button>
          </div>
          {loading ? (
            <p className="hint-text">加载文件…</p>
          ) : entries.length === 0 ? (
            <div className="research-empty"><p>项目目录还是空的。运行分析脚本、导出 Word/LaTeX 或让 AI 写代码后，文件会出现在这里。</p></div>
          ) : (
            <div className="rs-filetree" role="tree" aria-label="项目文件">{renderNodes(tree, 0)}</div>
          )}
        </div>

        <div className="card rs-files__preview-card">
          <div className="research-section-head">
            <h3>{selectedEntry === null ? "预览" : selectedEntry.name}</h3>
            {selectedEntry !== null && (
              <span className="hint-text">{formatBytes(selectedEntry.size) + " · " + formatDateTime(selectedEntry.modifiedAt)}</span>
            )}
            <span className="spacer" />
            <button type="button" className="button research-btn-sm" disabled={selectedEntry === null} onClick={() => void copyRelativePath()}>
              复制相对路径
            </button>
            <button type="button" className="button research-btn-sm" disabled={selectedEntry === null} onClick={() => void openInSystem()}>
              用系统应用打开
            </button>
          </div>
          {selectedEntry !== null && <p className="hint-text rs-files__path">{selectedEntry.path}</p>}
          <div className="rs-files__preview-body">{renderPreview()}</div>
        </div>
      </div>
    </div>
  );
}
