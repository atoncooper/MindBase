"use client";

// Native Word (.docx) renderer for the transcript and the cloud-drive viewer.
//
// "Native" here means the browser renders the actual OOXML package (fonts,
// paragraphs, tables, headers/footers, page breaks) through docx-preview —
// not a reconstructed block view and not screenshots. The binary is fetched
// from the cloud drive's presigned URL (same-origin /minio-proxy), so nothing
// extra is proxied through app-ts.
//
// Safety: docx-preview only produces DOM elements, but a hostile package can
// carry scripts/embedded objects or javascript: links. Everything it produces
// is walked once after render (hardenRenderedDom) to strip those.
//
// Layout: by default the viewer caps at 72vh (transcript card). With `fill`
// it instead takes the parent's full height, scrolls internally and scales the
// paper pages down to the available width (cloud-drive detail page).

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

interface NativeDocxViewerProps {
  /** Presigned/same-origin URL of the .docx object. */
  src: string;
  /** Called when the binary cannot be fetched or rendered (caller may fall back). */
  onError?: () => void;
  className?: string;
  /**
   * Fill the parent's height and scroll inside the viewer instead of capping
   * at 72vh. Pages are scaled down (never up) to fit the available width.
   */
  fill?: boolean;
}

/** Removes active content and unsafe links from the rendered document. */
function hardenRenderedDom(root: HTMLElement): void {
  root.querySelectorAll("script, iframe, object, embed, form").forEach((node) => node.remove());
  root.querySelectorAll("a").forEach((anchor) => {
    const href = anchor.getAttribute("href") ?? "";
    if (/^\s*(?:javascript|vbscript|data):/i.test(href)) {
      anchor.removeAttribute("href");
    }
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
  });
  root.querySelectorAll("img").forEach((image) => {
    image.removeAttribute("srcset");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
  });
}

/** docx-preview writes page widths as CSS lengths (e.g. "595.30pt"). */
function cssLengthToPx(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)\s*(px|pt|pc|in|cm|mm)?$/i.exec(value.trim());
  if (!match) return 0;
  const size = Number(match[1]);
  if (!Number.isFinite(size)) return 0;
  switch ((match[2] ?? "px").toLowerCase()) {
    case "pt":
      return (size * 4) / 3;
    case "pc":
      return size * 16;
    case "in":
      return size * 96;
    case "cm":
      return (size * 96) / 2.54;
    case "mm":
      return (size * 96) / 25.4;
    default:
      return size;
  }
}

/**
 * Scale each rendered page down (never up) so it fits the container width.
 * docx-preview keeps the paper pages in a centered flex column, so shrinking
 * the page keeps it horizontally centered over the grey canvas.
 */
function fitPagesToWidth(container: HTMLElement): void {
  const wrapper = container.querySelector<HTMLElement>(".docx-wrapper");
  if (!wrapper) return;
  const available = wrapper.clientWidth;
  if (available <= 0) return;
  const sections = Array.from(
    container.querySelectorAll<HTMLElement>(".docx-wrapper > section.docx")
  );
  for (const section of sections) {
    if (!section.dataset.baseWidthPx) {
      // Cache the unscaled page width once; later passes may already be zoomed.
      const inline = cssLengthToPx(section.style.width);
      section.dataset.baseWidthPx = String(inline > 0 ? inline : section.offsetWidth);
    }
    const baseWidth = Number(section.dataset.baseWidthPx);
    if (!Number.isFinite(baseWidth) || baseWidth <= 0) continue;
    const scale = Math.min(1, available / baseWidth);
    if (scale < 0.999) {
      section.style.setProperty("zoom", String(scale));
    } else {
      section.style.removeProperty("zoom");
    }
  }
}

export function NativeDocxViewer({ src, onError, className, fill = false }: NativeDocxViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    void (async () => {
      try {
        const response = await fetch(src, { credentials: "omit" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const buffer = await response.arrayBuffer();
        if (cancelled || !container) return;
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        container.replaceChildren();
        await renderAsync(buffer, container, undefined, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        });
        if (cancelled) return;
        hardenRenderedDom(container);
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setStatus("error");
        onError?.();
      }
    })();
    return () => {
      cancelled = true;
      if (container) container.replaceChildren();
    };
  }, [src, onError]);

  // Full-height mode: fit pages to the container and keep them fitted when the
  // viewport (or the AI drawer opening/closing) changes the available width.
  useEffect(() => {
    if (!fill || status !== "ready") return;
    const container = containerRef.current;
    if (!container) return;
    const fit = () => fitPagesToWidth(container);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fill, status]);

  return (
    <div className={fill ? `${className ?? ""} flex h-full min-h-0 flex-col` : className}>
      {status === "loading" && (
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-6 text-[12px] text-secondary">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-tertiary" aria-hidden="true" />
          正在渲染原始 Word 文档…
        </div>
      )}
      {status === "error" && !onError && (
        <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 text-[12px] text-secondary">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          文档渲染失败，可下载后用 Word 打开。
        </div>
      )}
      <div
        ref={containerRef}
        aria-label="原始 Word 文档"
        className={
          status === "ready"
            ? `native-docx-root overflow-y-auto overflow-x-hidden rounded-lg border border-border-subtle bg-[#eef0f3] p-3 ${
                fill ? "native-docx-fill min-h-0 flex-1" : "max-h-[72vh]"
              }`
            : "hidden"
        }
      />
      <style>{`
        .native-docx-root .docx-wrapper {
          background: transparent;
          padding: 0;
        }
        .native-docx-root .docx-wrapper > section.docx {
          margin: 0 auto 14px;
          box-shadow: 0 1px 4px rgba(15, 23, 42, 0.12);
          max-width: 100%;
        }
        /* Full-height mode scales pages itself, so the viewport width must not
           clamp the paper width before the scale is applied. */
        .native-docx-fill .docx-wrapper > section.docx {
          max-width: none;
        }
        .native-docx-root .docx-wrapper > section.docx:last-child {
          margin-bottom: 0;
        }
      `}</style>
    </div>
  );
}
