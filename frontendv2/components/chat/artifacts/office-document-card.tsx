"use client";

// Paper-style Word document preview for the chat transcript and the cloud-drive
// detail page (`kind: "office-document"` artifacts / GET /chat/office/document).
//
// Rendered purely with React elements from the validated block list: no iframe,
// no dangerouslySetInnerHTML and no page screenshots. The card folds on the
// header chevron, and long documents show the first ~24 blocks until the reader
// asks for the rest. Payloads are validated by isOfficeDocumentData() before
// they reach this component (see lib/artifacts/office-document-spec.ts).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cloudApi } from "@/lib/api/cloud";
import { NativeDocxViewer } from "./native-docx-viewer";
import { Check, ChevronDown, Copy, Download, FileText, FolderOpen } from "lucide-react";
import type {
  OfficeDocumentBlock,
  OfficeDocumentData,
  OfficeDocumentHeadingLevel,
} from "@/lib/artifacts/office-document-spec";

/** Blocks rendered before the "展开全文" gate. */
const PREVIEW_BLOCK_LIMIT = 24;

const ACTION_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground";

/**
 * Only absolute http(s) URLs and site-relative paths are usable as a download
 * target, so an artifact payload cannot smuggle javascript:/data: past the
 * anchor.
 */
function isSafeHref(value: string | undefined): value is string {
  if (!value) return false;
  if (/^https?:\/\/[^\s]+$/i.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//") && !/\s/.test(value);
}

function PaperHeading({ level, text }: { level: OfficeDocumentHeadingLevel; text: string }) {
  const size = level === 1 ? "text-[18px]" : level === 2 ? "text-[16px]" : "text-[14px]";
  return (
    <p
      role="heading"
      aria-level={level + 2}
      className={`mt-5 mb-2 whitespace-pre-wrap break-words font-bold leading-snug text-[#1d1d1f] ${size}`}
    >
      {text}
    </p>
  );
}

function PaperTable({ headers, rows }: { headers?: string[]; rows: string[][] }) {
  // Ragged rows are padded to the widest row; the guard already capped width.
  const columnCount = Math.max(headers?.length ?? 0, ...rows.map((row) => row.length));
  const headerCells = headers ?? [];
  return (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-left text-[13px] leading-relaxed text-[#1d1d1f]">
        {headerCells.length > 0 && (
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, index) => (
                <th
                  key={index}
                  scope="col"
                  className="border border-[#e3e3e6] bg-[#f5f5f7] px-2.5 py-1.5 font-semibold whitespace-pre-wrap break-words"
                >
                  {headerCells[index] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 === 1 ? "bg-[#fafafa]" : undefined}>
              {Array.from({ length: columnCount }, (_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border border-[#e3e3e6] px-2.5 py-1.5 align-top whitespace-pre-wrap break-words"
                >
                  {row[cellIndex] || "\u00a0"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaperBlock({ block }: { block: OfficeDocumentBlock }) {
  switch (block.type) {
    case "heading":
      return <PaperHeading level={block.level} text={block.text} />;
    case "paragraph":
      return (
        <p className="my-2 whitespace-pre-wrap break-words text-[14px] leading-[1.75] text-[#1d1d1f] [text-indent:2em]">
          {block.text}
        </p>
      );
    case "bullets": {
      const ordered = block.ordered === true;
      const ListTag = ordered ? "ol" : "ul";
      return (
        <ListTag
          className={`my-2 space-y-1 pl-6 text-[14px] leading-[1.75] text-[#1d1d1f] ${
            ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {block.items.map((item, index) => (
            <li key={index} className="whitespace-pre-wrap break-words pl-0.5">
              {item}
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return <PaperTable headers={block.headers} rows={block.rows} />;
    case "quote":
      return (
        <blockquote className="my-3 border-l-[3px] border-[#d2d2d7] pl-3 whitespace-pre-wrap break-words text-[13.5px] leading-[1.75] text-[#6e6e73]">
          {block.text}
        </blockquote>
      );
    case "pageBreak":
      return <hr className="my-5 border-0 border-t border-dashed border-[#d2d2d7]" aria-hidden="true" />;
    default:
      return null;
  }
}

interface OfficeDocumentCardProps {
  data: OfficeDocumentData;
  /** Optional short-lived download URL carried by the artifact frame. */
  downloadUrl?: string;
}

export function OfficeDocumentCard({ data, downloadUrl }: OfficeDocumentCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Native rendering: fetch the actual .docx from the cloud drive (presigned
  // URL) and let docx-preview lay it out in the browser. The structured block
  // view stays as the fallback until the binary is ready (or if it fails).
  //
  // State is keyed by uploadUuid instead of being reset inside the effect, so a
  // file switch cannot flash the previous file's preview (and the effect never
  // calls setState synchronously).
  const uploadUuid = data.uploadUuid;
  const [native, setNative] = useState<{ uuid: string; url: string | null; failed: boolean }>({
    uuid: "",
    url: null,
    failed: false,
  });
  const nativeFresh = native.uuid === (uploadUuid ?? "");
  const nativeUrl = nativeFresh ? native.url : null;
  const nativeFailed = nativeFresh ? native.failed : false;

  useEffect(() => {
    let cancelled = false;
    if (!uploadUuid) return;
    void (async () => {
      try {
        const raw = await cloudApi.getRawFile(uploadUuid);
        if (cancelled) return;
        setNative({ uuid: uploadUuid, url: raw.url || null, failed: false });
      } catch {
        // Keep the structured fallback; the footer still offers download/open.
        if (!cancelled) setNative({ uuid: uploadUuid, url: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uploadUuid]);

  const title = data.meta?.title?.trim();
  const subtitle = data.meta?.subtitle?.trim();
  const byline = [data.meta?.author?.trim(), data.meta?.date?.trim()]
    .filter((part): part is string => !!part)
    .join(" · ");

  const driveHref = data.uploadUuid
    ? `/cloud-drive/${encodeURIComponent(data.uploadUuid)}`
    : undefined;
  const downloadHref = isSafeHref(downloadUrl) ? downloadUrl : undefined;
  const copyHref = downloadHref ?? driveHref;

  const hasMore = data.blocks.length > PREVIEW_BLOCK_LIMIT;
  const visibleBlocks =
    hasMore && !expanded ? data.blocks.slice(0, PREVIEW_BLOCK_LIMIT) : data.blocks;

  const copyLink = useCallback(async () => {
    if (!copyHref) return;
    try {
      await navigator.clipboard.writeText(copyHref);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (insecure context / permission denied): stay quiet.
    }
  }, [copyHref]);

  return (
    <div className="min-w-0 sm:col-span-2">
      <section
        aria-label={`Word 文档预览：${data.name}`}
        className="overflow-hidden rounded-xl border border-border-subtle bg-surface"
      >
        <header className="flex items-center gap-2.5 px-3 py-2.5">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#2B579A] text-white"
            aria-hidden="true"
          >
            <FileText className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground" title={data.name}>
              {data.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-tertiary">
              Word 文档 · {nativeUrl && !nativeFailed ? "原生渲染" : data.blocks.length + " 个内容块"}
              {nativeUrl && !nativeFailed ? "" : data.truncated ? " · 内容已截断" : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开文档预览" : "收起文档预览"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
              aria-hidden="true"
            />
          </button>
        </header>

        {!collapsed && (
          <div className="border-t border-border-subtle bg-background/60 px-3 py-3 sm:px-4">
            {nativeUrl && !nativeFailed ? (
              <NativeDocxViewer src={nativeUrl} onError={() => setNative({ uuid: uploadUuid ?? "", url: nativeUrl, failed: true })} />
            ) : (
            <article className="mx-auto w-full max-w-[640px] rounded-md border border-[#e5e5e7] bg-white px-5 py-7 text-[#1d1d1f] shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:px-8 sm:py-9">
              {(title || subtitle || byline) && (
                <header className="mb-6 text-center">
                  {title && (
                    <h3 className="text-[22px] leading-snug font-bold tracking-tight text-[#1d1d1f]">
                      {title}
                    </h3>
                  )}
                  {subtitle && (
                    <p className="mt-2 text-[13px] leading-relaxed text-[#6e6e73]">{subtitle}</p>
                  )}
                  {byline && <p className="mt-2 text-[11.5px] text-[#86868b]">{byline}</p>}
                </header>
              )}

              {visibleBlocks.map((block, index) => (
                <PaperBlock key={index} block={block} />
              ))}

              {hasMore && (
                <div className="mt-5 border-t border-dashed border-[#e5e5e7] pt-3 text-center">
                  <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    className="text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
                  >
                    {expanded ? "收起" : `展开全文（共 ${data.blocks.length} 个内容块）`}
                  </button>
                </div>
              )}

              {data.truncated && (
                <p className="mt-4 text-center text-[11px] leading-relaxed text-[#aeaeb2]">
                  文档较长，以上为前 {data.blocks.length} 个内容块的预览
                </p>
              )}
            </article>
            )}
          </div>
        )}

        {(downloadHref || driveHref || copyHref) && (
          <footer className="flex flex-wrap items-center gap-1 border-t border-border-subtle px-2 py-1.5">
            {downloadHref && (
              <a
                href={downloadHref}
                download={data.name}
                target="_blank"
                rel="noopener noreferrer"
                className={ACTION_BUTTON_CLASS}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                下载
              </a>
            )}
            {driveHref && (
              <Link href={driveHref} className={ACTION_BUTTON_CLASS}>
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                在云盘打开
              </Link>
            )}
            {copyHref && (
              <button type="button" onClick={() => void copyLink()} className={ACTION_BUTTON_CLASS}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? "已复制" : "复制链接"}
              </button>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? "链接已复制" : ""}
            </span>
          </footer>
        )}
      </section>
    </div>
  );
}
