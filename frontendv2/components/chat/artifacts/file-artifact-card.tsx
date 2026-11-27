"use client";

// File artifact card for the chat transcript: a compact generated-output row
// with a colour-coded file-type tile, the file name + size, a quiet
// action/description line and an action row (download / open in cloud drive /
// copy link). No page screenshots: office documents get their own structured
// paper preview card; only image files keep a small hover thumbnail of the image
// file itself.
//
// Dispatched by <ArtifactCard> in chat-message.tsx for `kind: "file"` payloads
// and for legacy flat file artifacts mapped through legacyFileArtifactData().
// Payloads are validated by isFileArtifactData() before they reach this
// component, so `data` is safe to render as-is.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  Download,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Presentation,
} from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatBytes } from "@/lib/api/cloud";
import {
  type FileArtifactAction,
  type FileArtifactData,
} from "@/lib/artifacts/file-spec";

const ACTION_LABELS: Record<FileArtifactAction, string> = {
  generated: "已生成",
  edited: "已编辑",
  exported: "已导出",
  uploaded: "已上传",
};

const ICON_CLASS = "h-5 w-5";

const ACTION_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-secondary transition-colors";
const ACTION_DOWNLOAD_CLASS = ACTION_BUTTON_CLASS + " hover:bg-[#EFF6FF] hover:text-[#1D4ED8]";
const ACTION_DRIVE_CLASS = ACTION_BUTTON_CLASS + " hover:bg-[#ECFDF5] hover:text-[#047857]";
const ACTION_COPY_CLASS = ACTION_BUTTON_CLASS + " hover:bg-[#F5F3FF] hover:text-[#6D28D9]";

type FileVisual = { tileClass: string; icon?: ReactNode; badge?: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// Light pastel tile + coloured glyph: generated files should feel bright in the
// transcript, so brand colours tint the icon on a soft background instead of
// dark solid blocks with white icons.
function fileVisual(name: string, mime?: string): FileVisual {
  if (mime?.startsWith("image/")) {
    return {
      tileClass: "bg-[#F3E8FF] text-[#7C3AED]",
      icon: <FileImage className={ICON_CLASS} aria-hidden="true" />,
    };
  }
  switch (extensionOf(name)) {
    case "py":
    case "pyw":
      return { tileClass: "bg-[#EAF2FB] text-[#3776AB]", badge: "PY" };
    case "doc":
    case "docx":
      return {
        tileClass: "bg-[#EAF1FB] text-[#2B579A]",
        icon: <FileText className={ICON_CLASS} aria-hidden="true" />,
      };
    case "xls":
    case "xlsx":
    case "csv":
      return {
        tileClass: "bg-[#E9F6EE] text-[#1E7B45]",
        icon: <FileSpreadsheet className={ICON_CLASS} aria-hidden="true" />,
      };
    case "ppt":
    case "pptx":
    case "key":
      return {
        tileClass: "bg-[#FEF0E7] text-[#C43E1C]",
        icon: <Presentation className={ICON_CLASS} aria-hidden="true" />,
      };
    case "pdf":
      return {
        tileClass: "bg-[#FDECEA] text-[#D93025]",
        icon: <FileText className={ICON_CLASS} aria-hidden="true" />,
      };
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
      return {
        tileClass: "bg-[#FFF7E6] text-[#B45309]",
        icon: <FileArchive className={ICON_CLASS} aria-hidden="true" />,
      };
    case "md":
    case "markdown":
    case "mdx":
      return {
        tileClass: "bg-[#EFF6FF] text-[#2563EB]",
        icon: <FileText className={ICON_CLASS} aria-hidden="true" />,
      };
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
    case "json":
      return {
        tileClass: "bg-[#EEF2FF] text-[#4F46E5]",
        icon: <FileCode2 className={ICON_CLASS} aria-hidden="true" />,
      };
    default:
      return {
        tileClass: "bg-[#F0F9FF] text-[#0284C7]",
        icon: <File className={ICON_CLASS} aria-hidden="true" />,
      };
  }
}

export function FileArtifactCard({ data }: { data: FileArtifactData }) {
  const [copied, setCopied] = useState(false);
  const visual = fileVisual(data.name, data.mime);
  const driveHref = data.uploadUuid
    ? `/cloud-drive/${encodeURIComponent(data.uploadUuid)}`
    : undefined;
  // Image artifacts preview the image file itself on hover; this is the user's
  // image, not a rendered page screenshot of a generated document.
  const isImage = !!data.url && !!data.mime?.startsWith("image/");
  const actionLabel = data.action ? ACTION_LABELS[data.action] : "文件";
  const added = data.change?.added ?? 0;
  const removed = data.change?.removed ?? 0;
  const size = typeof data.sizeBytes === "number" ? formatBytes(data.sizeBytes) : undefined;
  const hasActions = !!(data.url || driveHref);

  const copyLink = async () => {
    if (!driveHref) return;
    try {
      // Always share the frontend page (cloud-drive detail), never the raw
      // MinIO proxy URL that backs downloads.
      await navigator.clipboard.writeText(new URL(driveHref, window.location.origin).toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (insecure context / permission denied): stay quiet.
    }
  };

  return (
    <div className="min-w-0 sm:col-span-2">
      <div
        role="group"
        aria-label={`文件：${data.name}`}
        className="overflow-hidden rounded-xl border border-[#E6EAF2] bg-gradient-to-br from-white via-white to-[#F7FAFF] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-[#CBD5E1] hover:shadow-[0_3px_10px_rgba(15,23,42,0.06)]"
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          <span
            className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl ${visual.tileClass}`}
            aria-hidden="true"
          >
            {visual.badge ? (
              <span className="text-[11px] font-semibold tracking-wide">{visual.badge}</span>
            ) : (
              visual.icon
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground" title={data.name}>
                {data.name}
              </span>
              {size && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">{size}</span>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-tertiary">
              <span className="shrink-0">{actionLabel}</span>
              {data.description && (
                <>
                  <span className="shrink-0" aria-hidden="true">
                    ·
                  </span>
                  <span className="min-w-0 truncate">{data.description}</span>
                </>
              )}
              {added > 0 && (
                <span className="shrink-0 font-mono tabular-nums text-success" title={`新增 ${added} 行`}>
                  +{added}
                </span>
              )}
              {removed > 0 && (
                <span className="shrink-0 font-mono tabular-nums text-danger" title={`删除 ${removed} 行`}>
                  −{removed}
                </span>
              )}
            </div>
          </div>

          {isImage && data.url && (
            <HoverCard openDelay={120} closeDelay={80}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  aria-label={`预览图片：${data.name}`}
                  className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-border-subtle bg-border-subtle transition-opacity hover:opacity-90"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={data.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              </HoverCardTrigger>
              <HoverCardContent side="top" align="end" className="w-72 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.url}
                  alt={data.name}
                  className="max-h-72 w-full rounded-lg object-contain"
                />
              </HoverCardContent>
            </HoverCard>
          )}
        </div>

        {hasActions && (
          <div className="flex flex-wrap items-center gap-1 border-t border-border-subtle px-2 py-1.5">
            {data.url && (
              <a
                href={data.url}
                download={data.name}
                target="_blank"
                rel="noopener noreferrer"
                className={ACTION_DOWNLOAD_CLASS}
              >
                <Download className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                下载
              </a>
            )}
            {driveHref && (
              <Link href={driveHref} className={ACTION_DRIVE_CLASS}>
                <FolderOpen className="h-3.5 w-3.5 text-[#059669]" aria-hidden="true" />
                云盘打开
              </Link>
            )}
            {driveHref && (
              <button type="button" onClick={() => void copyLink()} className={ACTION_COPY_CLASS}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-[#7C3AED]" aria-hidden="true" />
                )}
                {copied ? "已复制" : "复制链接"}
              </button>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? "链接已复制" : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
