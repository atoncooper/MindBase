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
 *  - docx                        -> structured paper-style document preview
 *                                   on demand (no page screenshots)
 *  - anything else                -> download link
 *
 * Layout: sticky frosted header + an edge-to-edge preview that fills the whole
 * remaining viewport. AI summary / similar files / "ask this file" live in a
 * right-hand drawer opened from the header, not in a column under the preview.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown";
import {
    ArrowLeft,
    Loader2,
    AlertCircle,
    Download,
    FileText,
    Pencil,
    Sparkles,
    X,
} from "lucide-react";
import { cloudApi, formatBytes, type CloudHlsResponse, type CloudRawFileResponse } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { FileAiPanel } from "./file-ai-panel";
import { FileDocumentPreview, isDocxDocument } from "./file-document-preview";
import { RenameFileDialog } from "./rename-file-dialog";
import { describeMimeType } from "./helpers";
import { toSameOriginUrl } from "./media-url";
import { CloudVideoPlayer } from "./video-player";
import { HlsVideoPlayer } from "./hls-video-player";
import { HlsStatusChip } from "./hls-packaging-card";
import { useHlsPlayback } from "./use-hls-playback";

const AI_DRAWER_ID = "file-ai-drawer";

export function FileViewer() {
    const pathname = usePathname();
    const router = useRouter();
    const uuid = pathname.split("/").pop() ?? "";

    const [raw, setRaw] = useState<CloudRawFileResponse | null>(null);
    // Seeded once from the raw-file fetch; the hook owns polling/retry state.
    const [hlsInitial, setHlsInitial] = useState<CloudHlsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameError, setRenameError] = useState<string | null>(null);
    // The drawer is open only for the file it was opened for: switching files
    // closes it without a state-resetting effect (the summary is file-scoped).
    const [aiOpenUuid, setAiOpenUuid] = useState<string | null>(null);
    const aiOpen = aiOpenUuid === uuid;
    const aiTriggerRef = useRef<HTMLButtonElement | null>(null);
    const aiCloseRef = useRef<HTMLButtonElement | null>(null);
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

    const closeAi = useCallback(() => {
        setAiOpenUuid(null);
        // Return focus to the trigger so keyboard users stay oriented.
        aiTriggerRef.current?.focus();
    }, []);

    // Drawer behaviour: lock background scrolling, close on Esc, move focus in.
    useEffect(() => {
        if (!aiOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeAi();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        const focusTimer = window.setTimeout(() => aiCloseRef.current?.focus(), 0);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener("keydown", onKeyDown);
            window.clearTimeout(focusTimer);
        };
    }, [aiOpen, closeAi]);

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

    // Videos keep the AI drawer hidden (same rule as the old inline panel).
    const aiAvailable = !raw.mimeType.startsWith("video/");

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
                {aiAvailable && (
                    <button
                        ref={aiTriggerRef}
                        type="button"
                        onClick={() => setAiOpenUuid(uuid)}
                        aria-label="打开 AI 摘要侧边栏"
                        aria-expanded={aiOpen}
                        aria-controls={AI_DRAWER_ID}
                        title="AI 摘要"
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                        AI 摘要
                    </button>
                )}
                {raw && (
                    <button
                        type="button"
                        onClick={() => {
                            setRenameError(null);
                            setRenameOpen(true);
                        }}
                        title="重命名"
                        aria-label="重命名"
                        className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <Pencil className="h-[17px] w-[17px]" />
                    </button>
                )}
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

            <RenameFileDialog
                open={renameOpen}
                initialName={raw?.fileName ?? ""}
                busy={renaming}
                error={renameError}
                onClose={() => {
                    if (!renaming) setRenameOpen(false);
                }}
                onConfirm={(name) => {
                    setRenaming(true);
                    setRenameError(null);
                    void cloudApi
                        .updateVideo(uuid, { originalName: name })
                        .then((updated) => {
                            setRaw((prev) =>
                                prev ? { ...prev, fileName: updated.originalName } : prev
                            );
                            setRenameOpen(false);
                        })
                        .catch((e: unknown) => {
                            setRenameError(e instanceof Error ? e.message : "重命名失败");
                        })
                        .finally(() => setRenaming(false));
                }}
            />

            {/* Body: edge-to-edge preview filling the remaining viewport. */}
            <div className="relative min-h-0 flex-1 overflow-y-auto">
                <div className="h-full w-full">
                    <RawContent
                        raw={raw}
                        uuid={uuid}
                        hls={hls.info}
                        onHlsFallback={hls.playRaw}
                        onUrlChange={(url) => setRaw((prev) => (prev ? { ...prev, url } : prev))}
                        onRetryHls={() => void hls.retry()}
                        hlsRetrying={hls.retrying}
                        hlsError={hls.error}
                    />
                </div>
            </div>

            {/* AI drawer: slides in from the right over a dimmed overlay. */}
            {aiOpen && (
                <>
                    <div
                        className="file-ai-overlay fixed inset-0 z-30 bg-black/20"
                        onClick={closeAi}
                        aria-hidden="true"
                    />
                    <aside
                        id={AI_DRAWER_ID}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="file-ai-drawer-title"
                        className="file-ai-drawer fixed inset-y-0 right-0 z-40 flex w-[420px] max-w-[92vw] flex-col border-l border-border-subtle bg-background shadow-xl"
                    >
                        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                            <h2
                                id="file-ai-drawer-title"
                                className="flex items-center gap-2 text-[13px] font-semibold text-foreground"
                            >
                                <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                                AI 摘要
                            </h2>
                            <button
                                ref={aiCloseRef}
                                type="button"
                                onClick={closeAi}
                                title="关闭"
                                aria-label="关闭 AI 摘要"
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                <X className="h-[18px] w-[18px]" />
                            </button>
                        </header>
                        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                            <FileAiPanel uploadUuid={uuid} />
                        </div>
                    </aside>
                </>
            )}

            <style>{`
                @keyframes file-ai-drawer-in {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
                @keyframes file-ai-overlay-in {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                .file-ai-drawer {
                    animation: file-ai-drawer-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
                }
                .file-ai-overlay {
                    animation: file-ai-overlay-in 150ms ease-out;
                }
                @media (prefers-reduced-motion: reduce) {
                    .file-ai-drawer,
                    .file-ai-overlay {
                        animation: none;
                    }
                }
            `}</style>
        </div>
    );
}

/**
 * Video playback stage: the original MP4 starts immediately; HLS is a
 * progressive upgrade.
 *
 * Root cause of the old "absurdly slow" behaviour: the viewer blocked on HLS
 * packaging (minutes of ffmpeg for a long video) and, worse, videos uploaded
 * before HLS / whose MinIO webhook never fired had no status at all and showed
 * a spinner forever. Now:
 *  - raw MP4 plays right away (progressive + seekable);
 *  - a passive chip reports packaging without blocking;
 *  - a ready HLS rendition auto-upgrades ONLY while playback has not started
 *    meaningfully (<3s), otherwise the chip offers a manual switch that resumes
 *    at the current position;
 *  - a failed/unsupported HLS package never degrades raw playback.
 */
function VideoStage({
    raw,
    uuid,
    hls,
    onUrlChange,
    onHlsFallback,
    onRetryHls,
    hlsRetrying,
    hlsError,
}: {
    raw: CloudRawFileResponse;
    uuid: string;
    hls: CloudHlsResponse | null;
    onUrlChange: (url: string) => void;
    onHlsFallback: () => void;
    onRetryHls: () => void;
    hlsRetrying: boolean;
    hlsError: string | null;
}) {
    const hlsReady = Boolean(hls?.ready && hls.playlistUrl);
    const [mode, setMode] = useState<"raw" | "hls">(() => (hlsReady ? "hls" : "raw"));
    // Playback position of the raw player, used to resume after a switch.
    const positionRef = useRef(0);
    const autoUpgradeTried = useRef(false);

    // Auto-upgrade only before playback has meaningfully started: a package
    // that becomes ready mid-watch must not yank the video away.
    useEffect(() => {
        if (!hlsReady || mode === "hls" || autoUpgradeTried.current) return;
        if (positionRef.current >= 3) return;
        autoUpgradeTried.current = true;
        setMode("hls");
    }, [hlsReady, mode]);

    const switchToHls = useCallback(() => {
        autoUpgradeTried.current = true;
        setMode("hls");
    }, []);

    if (hlsReady && mode === "hls" && hls?.playlistUrl) {
        return (
            <HlsVideoPlayer
                uuid={uuid}
                playlistUrl={hls.playlistUrl}
                posterUrl={hls.posterUrl}
                expiresIn={hls.expiresIn}
                startAt={positionRef.current}
                onFallback={() => {
                    // HLS failed: fall back to the raw MP4 for the rest of the
                    // session (the hook stops polling too).
                    onHlsFallback();
                    setMode("raw");
                }}
                fill
            />
        );
    }

    return (
        <div className="relative h-full w-full">
            <CloudVideoPlayer
                uuid={uuid}
                initialUrl={raw.url}
                expiresIn={raw.expiresIn}
                startAt={positionRef.current}
                onUrlChange={onUrlChange}
                onProgress={(currentTime) => {
                    if (currentTime > 0) positionRef.current = currentTime;
                }}
                fill
            />
            {/* Passive overlay: never blocks the video, never covers controls. */}
            <div className="pointer-events-none absolute left-4 top-4 z-10 flex max-w-[min(92vw,26rem)]">
                <HlsStatusChip
                    status={hls?.status}
                    progress={hls?.progress}
                    ready={hlsReady && mode === "raw"}
                    retrying={hlsRetrying}
                    error={hlsError}
                    onRetry={onRetryHls}
                    onSwitchToHls={switchToHls}
                />
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
    onRetryHls,
    hlsRetrying,
    hlsError,
}: {
    raw: CloudRawFileResponse;
    uuid: string;
    hls: CloudHlsResponse | null;
    onUrlChange: (url: string) => void;
    onHlsFallback: () => void;
    onRetryHls: () => void;
    hlsRetrying: boolean;
    hlsError: string | null;
}) {
    switch (raw.viewMode) {
        case "video":
            return (
                <VideoStage
                    raw={raw}
                    uuid={uuid}
                    hls={hls}
                    onUrlChange={onUrlChange}
                    onHlsFallback={onHlsFallback}
                    onRetryHls={onRetryHls}
                    hlsRetrying={hlsRetrying}
                    hlsError={hlsError}
                />
            );
        case "audio":
            return (
                <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
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
                <div className="flex h-full w-full items-center justify-center p-3 sm:p-5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={raw.url}
                        alt={raw.fileName}
                        className="max-h-full max-w-full rounded-lg border border-border-subtle object-contain"
                    />
                </div>
            );
        case "pdf":
            // The auto-open effect opened a new tab (native PDF viewer); this
            // card covers the popup-blocked case with a real anchor link.
            return (
                <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
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
                    className="h-full w-full border-0 bg-white"
                />
            );
        case "markdown":
            if (raw.content == null) return <TooLargeDownload raw={raw} />;
            return (
                <div className="h-full w-full overflow-y-auto">
                    <div className="note-prose mx-auto w-full px-5 py-6 sm:px-10 sm:py-8">
                        <Markdown>{raw.content}</Markdown>
                    </div>
                </div>
            );
        case "text":
            if (raw.content == null) return <TooLargeDownload raw={raw} />;
            return (
                <div className="h-full w-full overflow-y-auto">
                    <pre className="mx-auto w-full whitespace-pre-wrap break-words px-5 py-6 font-sans text-[14px] leading-[1.75] text-foreground sm:px-10 sm:py-8">
                        {raw.content}
                    </pre>
                </div>
            );
        default:
            // Word documents render natively (docx-preview, auto-loaded) — no
            // "暂不支持在线查看" banner, no extra click.
            if (isDocxDocument(raw.fileName, raw.mimeType)) {
                return (
                    <div className="h-full w-full">
                        <FileDocumentPreview
                            uploadUuid={uuid}
                            fileName={raw.fileName}
                            mimeType={raw.mimeType}
                            fill
                        />
                    </div>
                );
            }
            return <UnsupportedState raw={raw} />;
    }
}

function TooLargeDownload({ raw }: { raw: CloudRawFileResponse }) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
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
        <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
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
