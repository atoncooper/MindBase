"use client";

// File artifact card for the chat transcript: one rounded row with a
// colour-coded file-type tile, a name + action/description line (+N / −N diff
// stats for rewrites), an optional image thumbnail and a dropdown of file
// actions (open / download / copy name / copy link).
//
// Dispatched by <ArtifactCard> in chat-message.tsx for `kind: "file"` payloads
// and for legacy flat file artifacts mapped through legacyFileArtifactData().
// Payloads are validated by isFileArtifactData() before they reach this
// component, so `data` is safe to render as-is.

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  fileArtifactHref,
  type FileArtifactAction,
  type FileArtifactData,
} from "@/lib/artifacts/file-spec";

const ACTION_LABELS: Record<FileArtifactAction, string> = {
  generated: "已生成",
  edited: "已编辑",
  exported: "已导出",
  uploaded: "已上传",
};

type CopyTarget = "name" | "link";

const ICON_CLASS = "h-5 w-5";

type FileVisual = { tileClass: string; icon?: ReactNode; badge?: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// Solid brand tile with a white glyph (Python / Word / Excel / PDF / archive /
// Markdown). Code and unknown files fall back to the app accent so a file from
// the agent always reads as "a file" even without a brand colour.
function fileVisual(name: string, mime?: string): FileVisual {
  if (mime?.startsWith("image/")) {
    return { tileClass: "bg-accent", icon: <FileImage className={ICON_CLASS} aria-hidden="true" /> };
  }
  switch (extensionOf(name)) {
    case "py":
    case "pyw":
      // Text badge keeps the Python tile readable at 40px (PSF blue).
      return { tileClass: "bg-[#3776AB]", badge: "PY" };
    case "doc":
    case "docx":
      return { tileClass: "bg-[#2B579A]", icon: <FileText className={ICON_CLASS} aria-hidden="true" /> };
    case "xls":
    case "xlsx":
    case "csv":
      return {
        tileClass: "bg-[#217346]",
        icon: <FileSpreadsheet className={ICON_CLASS} aria-hidden="true" />,
      };
    case "pdf":
      return { tileClass: "bg-[#D93025]", icon: <FileText className={ICON_CLASS} aria-hidden="true" /> };
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
      return { tileClass: "bg-[#616161]", icon: <FileArchive className={ICON_CLASS} aria-hidden="true" /> };
    case "md":
    case "markdown":
    case "mdx":
      return { tileClass: "bg-[#6B7280]", icon: <FileText className={ICON_CLASS} aria-hidden="true" /> };
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
    case "json":
      return { tileClass: "bg-accent", icon: <FileCode2 className={ICON_CLASS} aria-hidden="true" /> };
    default:
      return { tileClass: "bg-accent", icon: <File className={ICON_CLASS} aria-hidden="true" /> };
  }
}

export function FileArtifactCard({ data }: { data: FileArtifactData }) {
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const visual = fileVisual(data.name, data.mime);
  const href = fileArtifactHref(data);
  // Only an absolute URL opens away from the app; a cloud-drive path is an
  // in-app route opened with <Link>.
  const opensExternally = !!data.url && href === data.url;
  const isImage = !!data.url && !!data.mime?.startsWith("image/");
  const actionLabel = data.action ? ACTION_LABELS[data.action] : "文件";
  const added = data.change?.added ?? 0;
  const removed = data.change?.removed ?? 0;

  // Copy is async but Radix closes the menu on select; keep the menu open for
  // copy actions so the item can briefly turn into "已复制".
  const copy = useCallback(async (value: string, target: CopyTarget) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => {
        setCopied((current) => (current === target ? null : current));
      }, 1600);
    } catch {
      // Clipboard unavailable (insecure context / permission denied): stay quiet.
    }
  }, []);

  return (
    <div className="min-w-0 sm:col-span-2">
      <div
        role="group"
        aria-label={`文件：${data.name}`}
        className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3 py-2.5 transition-colors hover:border-border"
      >
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg text-white ${visual.tileClass}`}
          aria-hidden="true"
        >
          {visual.badge ? (
            <span className="text-[11px] font-semibold tracking-wide">{visual.badge}</span>
          ) : (
            visual.icon
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground" title={data.name}>
            {data.name}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-tertiary">
            <span className="min-w-0 truncate">
              {actionLabel}
              {data.description ? ` · ${data.description}` : ""}
            </span>
            {added > 0 && (
              <span
                className="shrink-0 font-mono tabular-nums text-success"
                title={`新增 ${added} 行`}
              >
                +{added}
              </span>
            )}
            {removed > 0 && (
              <span
                className="shrink-0 font-mono tabular-nums text-danger"
                title={`删除 ${removed} 行`}
              >
                −{removed}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isImage && data.url && (
            <HoverCard openDelay={120} closeDelay={80}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  aria-label={`预览图片：${data.name}`}
                  className="h-9 w-9 overflow-hidden rounded-md border border-border-subtle bg-border-subtle transition-opacity hover:opacity-90"
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`文件操作：${data.name}`}
                className="grid h-7 w-7 place-items-center rounded-md text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {href ? (
                <DropdownMenuItem asChild>
                  <Link
                    href={href}
                    target={opensExternally ? "_blank" : undefined}
                    rel={opensExternally ? "noopener noreferrer" : undefined}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    打开
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  打开
                </DropdownMenuItem>
              )}

              {data.url ? (
                <DropdownMenuItem asChild>
                  <a href={data.url} download={data.name} target="_blank" rel="noopener noreferrer">
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    下载
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  下载
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void copy(data.name, "name");
                }}
              >
                {copied === "name" ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied === "name" ? "已复制" : "复制文件名"}
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={!href}
                onSelect={(event) => {
                  event.preventDefault();
                  if (href) void copy(href, "link");
                }}
              >
                {copied === "link" ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied === "link" ? "已复制" : "复制链接"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <span className="sr-only" aria-live="polite">
          {copied === "name" ? "文件名已复制" : copied === "link" ? "链接已复制" : ""}
        </span>
      </div>
    </div>
  );
}
