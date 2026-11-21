"use client";

/**
 * FileViewer - full-page viewer for the *original* uploaded cloud file.
 *
 * Route: /cloud-drive/[uuid]. Extracts the uuid from the pathname (avoids the
 * Next 16 async-params dance, same convention as the shared-note page).
 *
 * Fetches a presigned MinIO GET URL (plus inline text for text-like types)
 * from /cloud/video/:uuid/raw and renders the file:
 *  - pdf                         -> auto-open in a NEW browser tab; the
 *                                   browser's native PDF viewer takes over
 *  - video / audio / image       -> browser element with the presigned URL
 *  - html / markdown / text      -> inline content (no CORS fetch)
 *  - anything else                -> download link
 *
 * Layout: sticky frosted header (back + icon + name + size + download) + a
 * centered reading column.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ArrowLeft, Loader2, AlertCircle, Download, FileText } from "lucide-react";
import { cloudApi, formatBytes, type CloudHlsResponse, type CloudRawFileResponse } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { FileAiPanel } from "./file-ai-panel";
import { describeMimeType } from "./helpers";
import { toSameOriginUrl } from "./media-url";
import { CloudVideoPlayer } from "./video-player";
import { HlsVideoPlayer } from "./hls-video-player";
import { HlsFailureCard, HlsPackagingCard } from "./hls-packaging-card";
import { useHlsPlayback } from "./use-hls-playback";

export function FileViewer() {
    const pathname = usePathname();
    const router = useRouter();
    const uuid = pathname.split("/").pop() ?? "";

    const [raw, setRaw] = useState<CloudRawFileResponse | null>(null);
    // Seeded once from the raw-file fetch; the hook owns polling/retry state.
    const [hlsInitial, setHlsInitial] = useState<CloudHlsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hls = useHlsPlayback(uuid, raw?.viewMode === "video", hlsInitial);

    // PDF: open the file in a NEW tab and let the browser's native viewer
    // take over; this page stays as a status card with manual links in case
    // the popup is blocked. The ref guard keeps React StrictMode's dev
    // double-invoke from opening two tabs.
    const pdfAutoOpened = useRef(false);
    useEffect(() => {
        if (raw?.viewMode === "pdf" && raw.url && !pdfAutoOpened.current) {
            pdfAutoOpened.current = true;
            window.open(raw.url, "_blank");
        }
    }, [raw?.viewMode, raw?.url]);

    useEffect(() => {
        if (!uuid) return;
        let cancelled = false;
        void (async () => {
            try {
                const r = await cloudApi.getRawFile(uuid);
                let hlsInfo: CloudHlsResponse | null = null;
                if (r.viewMode === "video") {
                    try {
                        // Keep the full descriptor: queued/processing/failed
                        // states drive the packaging UI below.
                        hlsInfo = await cloudApi.getHls(uuid);
                    } catch {
                        hlsInfo = null;
                    }
                }
                if (!cancelled) {
                    setRaw({ ...r, url: toSameOriginUrl(r.url) });
                    setHlsInitial(hlsInfo);
                    setLoading(false);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "文件不存在或已删除");
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [uuid]);

    if (loading) {
        return (
            <div className="flex h-[100dvh] items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
            </div>
        );
    }

    if (error || !raw) {
        return (
            <div className="flex h-[100dvh] flex-col items-center justify-center px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/5 text-danger">
                    <AlertCircle className="h-6 w-6" />
                </span>
                <p className="mt-4 text-[15px] font-medium text-foreground">
                    {error ?? "文件不存在"}
                </p>
                <button
                    type="button"
                    onClick={() => router.push("/cloud-drive")}
                    className="btn-pill btn-ghost mt-5 h-9 px-5 text-[13px]"
                >
                    <ArrowLeft className="h-4 w-4" />
                    返回云盘
                </button>
            </div>
        );
    }

    return (
        <div className="flex h-[100dvh] flex-col">
            {/* Sticky frosted header */}
            <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-border-subtle bg-background/75 px-4 py-2.5 backdrop-blur-xl">
                <button
                    type="button"
                    onClick={() => router.push("/cloud-drive")}
                    title="返回云盘"
                    aria-label="返回云盘"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    <ArrowLeft className="h-[18px] w-[18px]" />
                </button>
                <FileIconTile mimeType={raw.mimeType} size="sm" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-foreground" title={raw.fileName}>
                        {raw.fileName}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-secondary">
                        {formatBytes(raw.fileSize)}
                        <span className="mx-1.5 text-tertiary">·</span>
                        <span title={raw.mimeType}>{describeMimeType(raw.mimeType)}</span>
                    </p>
                </div>
                <a
                    href={raw.url}
                    download={raw.fileName}
                    title="下载原文件"
                    aria-label="下载原文件"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    <Download className="h-[17px] w-[17px]" />
                </a>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[960px] px-6 py-8 sm:px-10">
                    {uuid ? (
                        <div className="mb-8 rounded-2xl border border-border-subtle bg-surface/60 p-4">
                            <FileAiPanel uploadUuid={uuid} />
                        </div>
                    ) : null}
                    <RawContent
                        raw={raw}
                        uuid={uuid}
                        hls={hls.info}
                        onHlsFallback={hls.playRaw}
                        onUrlChange={(url) => setRaw((prev) => (prev ? { ...prev, url } : prev))}
                        onPlayRaw={hls.playRaw}
                        onRetryHls={() => void hls.retry()}
                        hlsRetrying={hls.retrying}
                        hlsError={hls.error}
                    />
                </div>
            </div>
        </div>
    );
}

function RawContent({
    raw,
    uuid,
    hls,
    onUrlChange,
    onHlsFallback,
    onPlayRaw,
    onRetryHls,
    hlsRetrying,
    hlsError,
}: {
    raw: CloudRawFileResponse;
    uuid: string;
    hls: CloudHlsResponse | null;
    onUrlChange: (url: string) => void;
    onHlsFallback: () => void;
    onPlayRaw: () => void;
    onRetryHls: () => void;
    hlsRetrying: boolean;
    hlsError: string | null;
}) {
    switch (raw.viewMode) {
        case "video":
            if (hls?.ready && hls.playlistUrl) {
                return (
                    <HlsVideoPlayer
                        uuid={uuid}
                        playlistUrl={hls.playlistUrl}
                        posterUrl={hls.posterUrl}
                        expiresIn={hls.expiresIn}
                        onFallback={onHlsFallback}
                    />
                );
            }
            if (hls && (hls.status === "queued" || hls.status === "processing")) {
                return (
                    <HlsPackagingCard
                        progress={hls.progress}
                        attempts={hls.attempts}
                        onPlayRaw={onPlayRaw}
                    />
                );
            }
            if (hls?.status === "failed") {
                // A failed package is surfaced (with retry) instead of silently
                // downgrading to the MP4 fallback.
                return (
                    <HlsFailureCard
                        message={hlsError}
                        attempts={hls.attempts}
                        retryable={hls.retryable !== false}
                        retrying={hlsRetrying}
                        onRetry={onRetryHls}
                        onPlayRaw={onPlayRaw}
                    />
                );
            }
            return (
                <CloudVideoPlayer
                    uuid={uuid}
                    initialUrl={raw.url}
                    expiresIn={raw.expiresIn}
                    onUrlChange={onUrlChange}
                />
            );
        case "audio":
            return (
                <div className="flex flex-col items-center justify-center py-16">
                    <span className="grid h-20 w-20 place-items-center rounded-3xl bg-accent-soft text-accent">
                        <FileText className="h-8 w-8" />
                    </span>
                    <p className="mt-4 max-w-md truncate text-center text-[14px] font-medium text-foreground">
                        {raw.fileName}
                    </p>
                    <audio src={raw.url} controls className="mt-6 w-full max-w-md" />
                </div>
            );
        case "image":
            return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={raw.url}
                    alt={raw.fileName}
                    className="mx-auto max-w-full rounded-2xl border border-border-subtle"
                />
            );
        case "pdf":
            // The auto-open effect opened a new tab (native PDF viewer); this
            // card covers the popup-blocked case with a real anchor link.
            return (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                    <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                        <FileText className="h-6 w-6" />
                    </span>
                    <p className="mt-4 text-[15px] font-medium text-foreground">PDF 已在新标签页打开</p>
                    <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                        由浏览器内置查看器展示；若新标签页未出现，点击下方链接手动打开。
                    </p>
                    <a
                        href={raw.url}
                        target="_blank"
                        rel="noopener"
                        className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]"
                    >
                        <FileText className="h-4 w-4" />
                        在新标签页打开 PDF
                    </a>
                    <a href={raw.url} download={raw.fileName} className="btn-pill btn-ghost mt-2 h-9 px-5 text-[13px]">
                        <Download className="h-4 w-4" />
                        下载原文件
                    </a>
                </div>
            );
        case "html":
            if (raw.content == null) return <TooLargeDownload raw={raw} />;
            return (
                <iframe
                    srcDoc={raw.content}
                    title={raw.fileName}
                    sandbox="allow-same-origin"
                    className="h-[80vh] w-full rounded-2xl border border-border-subtle bg-white"
                />
            );
        case "markdown":
            if (raw.content == null) return <TooLargeDownload raw={raw} />;
            return (
                <div className="note-prose">
                    <Markdown>{raw.content}</Markdown>
                </div>
            );
        case "text":
            if (raw.content == null) return <TooLargeDownload raw={raw} />;
            return (
                <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-[1.75] text-foreground">
                    {raw.content}
                </pre>
            );
        default:
            return <UnsupportedState raw={raw} />;
    }
}

function TooLargeDownload({ raw }: { raw: CloudRawFileResponse }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <FileText className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">文件过大，无法在线查看</p>
            <p className="mt-1.5 text-[13px] text-secondary">该文件超过 5 MB，请下载后查看。</p>
            <a href={raw.url} download={raw.fileName} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                <Download className="h-4 w-4" />
                下载原文件
            </a>
        </div>
    );
}

function UnsupportedState({ raw }: { raw: CloudRawFileResponse }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <FileText className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">暂不支持在线查看</p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                该文件类型（<span title={raw.mimeType}>{describeMimeType(raw.mimeType)}</span>）暂无在线预览，可下载后查看。
            </p>
            <a href={raw.url} download={raw.fileName} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                <Download className="h-4 w-4" />
                下载原文件
            </a>
        </div>
    );
}