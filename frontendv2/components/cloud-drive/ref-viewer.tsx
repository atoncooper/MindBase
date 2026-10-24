"use client";

/**
 * RefViewer - full-page viewer for a cloud_ref 引用条目 (plan/1.0.16 §6).
 *
 * Route: /cloud-drive/refs/[id]. Same rendering capabilities as FileViewer
 * (the original-file viewer): presigned URL from GET /cloud/refs/:id/raw,
 * video/audio/image inline, pdf auto-open in a new tab, markdown/text inline
 * (content fetched from the presigned URL, capped), everything else =
 * explicit download card. 失效（原文件删除/来源分享被封禁）→ 404「引用已失效」
 * error state with a back-to-drive action.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ArrowLeft, Loader2, AlertCircle, Download, FileText } from "lucide-react";
import { cloudApi, formatBytes, type CloudRefRawResponse } from "@/lib/api/cloud";
import { toSameOriginUrl } from "./file-viewer";
import { FileIconTile } from "./file-icon";

/**
 * 文本类预览的体积上限：超过则引导下载（与公开分享页同策略，
 * 避免把大文件整段塞进 DOM）。
 */
const TEXT_PREVIEW_CAP = 2 * 1024 * 1024;

type TextPreviewState =
    | { state: "loading"; content: "" }
    | { state: "ready"; content: string }
    | { state: "error"; content: "" };

export function RefViewer() {
    const pathname = usePathname();
    const router = useRouter();
    const id = Number(pathname.split("/").pop());

    const invalidId = !Number.isFinite(id) || id <= 0;
    const [raw, setRaw] = useState<CloudRefRawResponse | null>(null);
    const [loading, setLoading] = useState(!invalidId);
    const [error, setError] = useState<string | null>(null);

    // PDF: open the file in a NEW tab and let the browser's native viewer
    // take over (same guard against StrictMode double-invoke as FileViewer).
    const pdfAutoOpened = useRef(false);
    useEffect(() => {
        if (raw?.viewMode === "pdf" && raw.url && !pdfAutoOpened.current) {
            pdfAutoOpened.current = true;
            window.open(raw.url, "_blank");
        }
    }, [raw?.viewMode, raw?.url]);

    useEffect(() => {
        if (invalidId) return;
        let cancelled = false;
        void (async () => {
            try {
                const r = await cloudApi.rawRefFile(id);
                if (!cancelled) {
                    setRaw({ ...r, url: toSameOriginUrl(r.url) });
                    setLoading(false);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "引用已失效");
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [id, invalidId]);

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
                    {error ?? "引用已失效"}
                </p>
                <p className="mt-1.5 text-[13px] text-secondary">
                    原文件可能已删除，或来源分享已被撤销/封禁/过期。
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
                    <p className="mt-0.5 text-[11px] text-secondary">
                        {formatBytes(raw.fileSize)}
                        <span className="mx-1.5 text-tertiary">·</span>
                        <span className="truncate">{raw.mimeType}</span>
                        <span className="mx-1.5 text-tertiary">·</span>
                        <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                            引用
                        </span>
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
                    <RefContent raw={raw} />
                </div>
            </div>
        </div>
    );
}

function RefContent({ raw }: { raw: CloudRefRawResponse }) {
    switch (raw.viewMode) {
        case "video":
            return (
                <video
                    src={raw.url}
                    controls
                    className="mx-auto w-full max-w-full rounded-2xl bg-black"
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
        case "markdown":
        case "text":
            return <TextualContent raw={raw} />;
        default:
            return <UnsupportedState raw={raw} />;
    }
}

/** markdown/text：引用 raw 不返回正文，直接从 presigned URL 拉取（2MB 上限）。 */
function TextualContent({ raw }: { raw: CloudRefRawResponse }) {
    const oversize = raw.fileSize > TEXT_PREVIEW_CAP;
    const [state, setState] = useState<TextPreviewState | null>(
        oversize ? null : { state: "loading", content: "" },
    );

    useEffect(() => {
        if (oversize) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(raw.url, { cache: "no-store" });
                if (!res.ok) throw new Error("fetch failed");
                const text = await res.text();
                if (!cancelled) setState({ state: "ready", content: text });
            } catch {
                if (!cancelled) setState({ state: "error", content: "" });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [raw.url, oversize]);

    if (oversize || state?.state === "error") return <TooLargeDownload raw={raw} />;
    if (state?.state === "loading" || !state) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
            </div>
        );
    }
    if (raw.viewMode === "markdown") {
        return (
            <div className="note-prose">
                <Markdown>{state.content}</Markdown>
            </div>
        );
    }
    return (
        <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-[1.75] text-foreground">
            {state.content}
        </pre>
    );
}

function TooLargeDownload({ raw }: { raw: CloudRefRawResponse }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <FileText className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">文件过大，无法在线查看</p>
            <p className="mt-1.5 text-[13px] text-secondary">该文件超过 2 MB，请下载后查看。</p>
            <a href={raw.url} download={raw.fileName} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                <Download className="h-4 w-4" />
                下载原文件
            </a>
        </div>
    );
}

function UnsupportedState({ raw }: { raw: CloudRefRawResponse }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-border-subtle text-secondary">
                <FileText className="h-6 w-6" />
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">暂不支持在线查看</p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                该文件类型（{raw.mimeType}）暂无在线预览，可下载后查看。
            </p>
            <a href={raw.url} download={raw.fileName} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                <Download className="h-4 w-4" />
                下载原文件
            </a>
        </div>
    );
}
