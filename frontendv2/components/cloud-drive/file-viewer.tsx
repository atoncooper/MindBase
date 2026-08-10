"use client";

/**
 * FileViewer - full-page viewer for the *original* uploaded cloud file.
 *
 * Route: /cloud-drive/[uuid]. Extracts the uuid from the pathname (avoids the
 * Next 16 async-params dance, same convention as the shared-note page).
 *
 * Fetches a presigned MinIO GET URL (plus inline text for text-like types)
 * from /cloud/video/:uuid/raw and renders the file natively:
 *  - video / audio / image / pdf -> browser element with the presigned URL
 *  - html / markdown / text       -> inline content (no CORS fetch)
 *  - anything else                -> download link
 *
 * Layout: sticky frosted header (back + icon + name + size + download) + a
 * centered reading column.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ArrowLeft, Loader2, AlertCircle, Download, FileText } from "lucide-react";
import { cloudApi, formatBytes, type CloudRawFileResponse } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";

export function FileViewer() {
    const pathname = usePathname();
    const router = useRouter();
    const uuid = pathname.split("/").pop() ?? "";

    const [raw, setRaw] = useState<CloudRawFileResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!uuid) return;
        let cancelled = false;
        void (async () => {
            try {
                const r = await cloudApi.getRawFile(uuid);
                if (!cancelled) {
                    setRaw(r);
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
                    <p className="mt-0.5 text-[11px] text-secondary">
                        {formatBytes(raw.fileSize)}
                        <span className="mx-1.5 text-tertiary">·</span>
                        <span className="truncate">{raw.mimeType}</span>
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
                    <RawContent raw={raw} />
                </div>
            </div>
        </div>
    );
}

function RawContent({ raw }: { raw: CloudRawFileResponse }) {
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
            return (
                <iframe
                    src={raw.url}
                    title={raw.fileName}
                    className="h-[80vh] w-full rounded-2xl border border-border-subtle"
                />
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
                该文件类型（{raw.mimeType}）暂无在线预览，可下载后查看。
            </p>
            <a href={raw.url} download={raw.fileName} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                <Download className="h-4 w-4" />
                下载原文件
            </a>
        </div>
    );
}
