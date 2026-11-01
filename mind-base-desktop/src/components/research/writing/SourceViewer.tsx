/**
 * 原始文档查看器：导入的 .docx 用 docx-preview 原样排版渲染，.pdf 复用后端
 * 逐页渲染命令分页浏览；其它类型提示切换「文本视图」（抽取的 Markdown）。
 */

import { useEffect, useRef, useState } from "react";
import { getResearchFilePdfPage, readResearchFileBytes } from "../../../lib/research-files";
import { errorText } from "../common";

export type SourceKind = "docx" | "pdf" | "other";

/** 按扩展名判断原始文档类型。 */
export function sourceKindOf(path: string): SourceKind {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  return "other";
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toDataUri(base64: string, mime: string): string {
  if (base64.startsWith("data:")) return base64;
  return "data:" + (mime === "" ? "application/octet-stream" : mime) + ";base64," + base64;
}

interface ViewerPartProps {
  projectId: string;
  path: string;
  onError?: (message: string) => void;
}

/** DOCX：readResearchFileBytes → docx-preview.renderAsync，容器内滚动。 */
function DocxView({ projectId, path, onError }: ViewerPartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container !== null) container.innerHTML = "";
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const file = await readResearchFileBytes(projectId, path);
        if (cancelled) return;
        const buffer = base64ToArrayBuffer(file.base64);
        const docx = await import("docx-preview");
        if (cancelled || containerRef.current === null) return;
        await docx.renderAsync(buffer, containerRef.current, undefined, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
        });
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          const message = errorText(err);
          setError(message);
          setLoading(false);
          onError?.(message);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (containerRef.current !== null) containerRef.current.innerHTML = "";
    };
  }, [projectId, path]);

  return (
    <div className="rs-srcview rs-srcview--docx">
      {loading && <p className="hint-text rs-srcview__hint">正在渲染 Word 文档…</p>}
      {error !== null && <p className="error-text rs-srcview__error">{error}</p>}
      <div className="rs-docx-preview" ref={containerRef} />
    </div>
  );
}

/** PDF：后端逐页渲染 PNG，分页 + DPI 切换。 */
function PdfView({ projectId, path, onError }: ViewerPartProps): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [dpi, setDpi] = useState(144);
  const [pageInput, setPageInput] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [dataUri, setDataUri] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  async function loadPage(target: number, targetDpi: number): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await getResearchFilePdfPage(projectId, path, target, targetDpi);
      if (pathRef.current !== path) return;
      setPage(result.page);
      setPageCount(result.pageCount);
      setDataUri(toDataUri(result.base64, result.mime));
      setPageInput(String(result.page));
    } catch (err) {
      if (pathRef.current !== path) return;
      const message = errorText(err);
      setError(message);
      onError?.(message);
    } finally {
      if (pathRef.current === path) setLoading(false);
    }
  }

  useEffect(() => {
    void loadPage(1, 144);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path]);

  function jump(): void {
    const target = Math.floor(Number(pageInput));
    if (!Number.isFinite(target) || target < 1) return;
    void loadPage(target, dpi);
  }

  return (
    <div className="rs-srcview rs-srcview--pdf">
      <div className="rs-srcview__bar">
        <button type="button" className="rs-ga__btn" disabled={loading || page <= 1} onClick={() => void loadPage(page - 1, dpi)}>
          上一页
        </button>
        <span className="rs-srcview__pagebox">
          <input
            className="rs-srcview__pageinput"
            type="number"
            min={1}
            max={pageCount > 0 ? pageCount : undefined}
            value={pageInput}
            aria-label="跳转到页码"
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") jump(); }}
          />
          <span className="hint-text">{"/ " + (pageCount > 0 ? pageCount : "?")}</span>
          <button type="button" className="rs-ga__btn" disabled={loading} onClick={jump}>跳转</button>
        </span>
        <button
          type="button"
          className="rs-ga__btn"
          disabled={loading || (pageCount > 0 && page >= pageCount)}
          onClick={() => void loadPage(page + 1, dpi)}
        >
          下一页
        </button>
        <span className="spacer" />
        <label className="rs-srcview__dpi">
          DPI
          <select className="research-select" value={String(dpi)} disabled={loading} onChange={(event) => { const next = Number(event.target.value); setDpi(next); void loadPage(page, next); }}>
            <option value="96">96</option>
            <option value="144">144</option>
            <option value="192">192</option>
          </select>
        </label>
      </div>
      {loading ? (
        <p className="hint-text rs-srcview__hint">正在渲染 PDF 页面…</p>
      ) : error !== null ? (
        <p className="error-text rs-srcview__error">{error}</p>
      ) : dataUri !== "" ? (
        <div className="rs-srcview__pagescroll">
          <img className="rs-srcview__pageimg" src={dataUri} alt={"第 " + page + " 页"} />
        </div>
      ) : (
        <p className="hint-text rs-srcview__hint">暂无页面图像。</p>
      )}
    </div>
  );
}

export interface SourceViewerProps {
  projectId: string;
  /** 项目文件根内相对路径（文档 sourcePath）。 */
  path: string;
  /** 原生渲染失败回调（docx / pdf），供上层自动回退文本视图。 */
  onError?: (message: string) => void;
}

export default function SourceViewer(props: SourceViewerProps): React.JSX.Element {
  const kind = sourceKindOf(props.path);
  if (kind === "docx") return <DocxView projectId={props.projectId} path={props.path} onError={props.onError} />;
  if (kind === "pdf") return <PdfView projectId={props.projectId} path={props.path} onError={props.onError} />;
  return (
    <div className="rs-srcview rs-srcview--other">
      <p className="hint-text">
        该文件类型没有可原样排版的预览（{props.path}）。切到「文本视图」可查看导入时抽取的 Markdown 内容。
      </p>
    </div>
  );
}
