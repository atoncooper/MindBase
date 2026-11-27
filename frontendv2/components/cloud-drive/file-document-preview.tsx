"use client";

/**
 * FileDocumentPreview - native Word rendering for docx files in the cloud drive.
 *
 * "Native" = the browser lays out the actual .docx package (fonts, tables,
 * headers/footers, page breaks) with docx-preview, fed by the cloud drive's
 * presigned raw URL. No screenshots and no iframe.
 *
 * Loading starts automatically when the viewer opens (no "click to preview"):
 *   raw URL -> fetch bytes -> renderAsync.
 * If the raw URL/bytes are unavailable, it falls back to the backend's
 * structured block preview (GET /chat/office/document) so the user still gets
 * readable content; a clean "unavailable" answer is shown in grey.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, RefreshCw } from "lucide-react";
import { OfficeDocumentCard } from "@/components/chat/artifacts/office-document-card";
import { NativeDocxViewer } from "@/components/chat/artifacts/native-docx-viewer";
import { requestErrorStatus } from "@/lib/api";
import { cloudApi } from "@/lib/api/cloud";
import { isOfficeDocumentData, type OfficeDocumentData } from "@/lib/artifacts/office-document-spec";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Only .docx gets the document view (legacy .doc and every other format stay on
 * the generic fallback). MIME is authoritative when present; the extension is
 * the fallback because browsers sometimes send a generic MIME.
 */
export function isDocxDocument(fileName: string, mimeType?: string): boolean {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime === DOCX_MIME) return true;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return false;
  return fileName.slice(dot + 1).toLowerCase() === "docx";
}

type PreviewState =
  | { uuid: string; status: "loading" }
  | { uuid: string; status: "native"; url: string }
  | { uuid: string; status: "structured"; data: OfficeDocumentData }
  | { uuid: string; status: "unavailable"; detail: string }
  | { uuid: string; status: "error"; message: string };

interface FileDocumentPreviewProps {
  uploadUuid: string;
  fileName: string;
  /** Optional; lets the MIME type win over the extension when present. */
  mimeType?: string;
  /**
   * Fill the parent's height and scroll the document inside the preview
   * (full-screen cloud-drive detail page) instead of the compact card layout.
   */
  fill?: boolean;
}

function errorMessage(error: unknown): string {
  const status = requestErrorStatus(error);
  if (status === 404) return "文件不存在或无权访问";
  if (status === 503) return "文档预览服务暂时不可用，请稍后重试";
  return error instanceof Error && error.message ? error.message : "文档预览加载失败";
}

export function FileDocumentPreview({
  uploadUuid,
  fileName,
  mimeType,
  fill = false,
}: FileDocumentPreviewProps) {
  const previewable = isDocxDocument(fileName, mimeType);
  const [state, setState] = useState<PreviewState>({ uuid: uploadUuid, status: "loading" });
  // Monotonic request id: a retry (or another file) invalidates what is in flight.
  const requestIdRef = useRef(0);

  const run = useCallback(
    async (showLoading: boolean) => {
      if (!previewable) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      if (showLoading) setState({ uuid: uploadUuid, status: "loading" });

      // 1) Native path: presigned original bytes -> docx-preview.
      try {
        const raw = await cloudApi.getRawFile(uploadUuid);
        if (requestIdRef.current !== requestId) return;
        if (raw.url) {
          setState({ uuid: uploadUuid, status: "native", url: raw.url });
          return;
        }
      } catch {
        // Fall through to the structured preview below.
        if (requestIdRef.current !== requestId) return;
      }

      // 2) Fallback: structured blocks parsed server-side.
      try {
        const result = await cloudApi.getOfficeDocument(uploadUuid);
        if (requestIdRef.current !== requestId) return;
        if (!result.available) {
          setState({
            uuid: uploadUuid,
            status: "unavailable",
            detail: result.detail || "当前无法预览该文档，请下载后查看",
          });
          return;
        }
        if (!isOfficeDocumentData(result.data)) {
          setState({ uuid: uploadUuid, status: "error", message: "文档预览数据不完整，请稍后重试" });
          return;
        }
        setState({ uuid: uploadUuid, status: "structured", data: result.data });
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setState({ uuid: uploadUuid, status: "error", message: errorMessage(error) });
      }
    },
    [previewable, uploadUuid],
  );

  useEffect(() => {
    if (!previewable) return;
    // Auto-load on open. The async wrapper keeps every state update in a promise
    // callback (never synchronously inside the effect body).
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await run(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [previewable, run]);

  useEffect(() => {
    // New file -> discard the response still in flight for the previous one.
    requestIdRef.current += 1;
  }, [uploadUuid]);

  if (!previewable) return null;

  const current: PreviewState =
    state.uuid === uploadUuid ? state : { uuid: uploadUuid, status: "loading" };

  return (
    <section
      aria-label="文档预览"
      aria-busy={current.status === "loading"}
      className={fill ? "flex h-full min-h-0 flex-col" : undefined}
    >
      {current.status === "native" ? (
        <NativeDocxViewer
          src={current.url}
          fill={fill}
          onError={() =>
            setState({
              uuid: uploadUuid,
              status: "error",
              message: "原生渲染失败，可下载后用 Word 打开，或稍后重试",
            })
          }
        />
      ) : (
        // Non-native states (structured fallback / loading / errors) scroll on
        // their own in fill mode so the detail page never grows past the viewport.
        <div className={fill ? "min-h-0 flex-1 overflow-y-auto p-4" : undefined}>
          {current.status === "structured" ? (
            <OfficeDocumentCard data={current.data} />
          ) : current.status === "unavailable" ? (
            <UnavailableHint detail={current.detail} />
          ) : current.status === "error" ? (
            <ErrorRow message={current.message} onRetry={() => void run(true)} />
          ) : (
            <LoadingRow />
          )}
        </div>
      )}
    </section>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-[12px] text-secondary">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-tertiary" aria-hidden="true" />
      <FileText className="h-3.5 w-3.5 text-tertiary" aria-hidden="true" />
      正在加载并渲染原始 Word 文档…
    </div>
  );
}

function UnavailableHint({ detail }: { detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-border-subtle bg-surface/60 px-4 py-3 text-[12px] leading-relaxed text-tertiary">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{detail}</span>
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <p className="flex items-start gap-2 text-[12px] leading-relaxed text-secondary">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        重试
      </button>
    </div>
  );
}
