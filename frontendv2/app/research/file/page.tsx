"use client";

/**
 * /research/file —— 写作文件新标签页查看器。
 *
 * 从写作文件列表点击文件后在新标签页打开：
 * - PDF → 浏览器内嵌 PDF 查看器（presigned URL）
 * - 图片 → <img>
 * - Word/Office/文本 → app-cloud 抽取的纯文本预览（未处理文件也支持），并提供下载
 * 不渲染原版 Word 排版（浏览器无法直接显示 docx），版式请下载后用 Word 打开。
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Download, FileText, Loader2, X } from "lucide-react";
import { cloudApi } from "@/lib/api";

interface PreviewState {
    fileName: string;
    mimeType: string;
    rawUrl: string;
    preview: string;
    totalChars: number;
}

function extOf(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function FileViewer() {
    const params = useSearchParams();
    const uploadUuid = params.get("uploadUuid") ?? "";
    const fallbackName = params.get("name") ?? "文件";
    const fallbackMime = params.get("mime") ?? "";

    const [state, setState] = useState<PreviewState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!uploadUuid) {
            setError("缺少文件参数");
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const raw = await cloudApi.getRawFile(uploadUuid);
            let preview = raw.content ?? "";
            let totalChars = preview.length;
            let fileName = raw.fileName || fallbackName;
            let mimeType = raw.mimeType || fallbackMime;
            try {
                const detail = await cloudApi.getDocumentPreview(uploadUuid, 0, 20000);
                if (detail.preview) preview = detail.preview;
                if (typeof detail.totalChars === "number") totalChars = detail.totalChars;
                fileName = detail.fileName || fileName;
                mimeType = detail.mimeType || mimeType;
            } catch {
                // Preview extraction is best-effort; raw URL still lets the user download.
            }
            setState({ fileName, mimeType, rawUrl: raw.url, preview, totalChars });
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载文件失败");
        } finally {
            setLoading(false);
        }
    }, [uploadUuid, fallbackName, fallbackMime]);

    useEffect(() => {
        void load();
    }, [load]);

    // Browser tab title mirrors the file name for multi-tab workflows.
    useEffect(() => {
        if (typeof document === "undefined") return;
        document.title = state?.fileName ? state.fileName + " · 写作文件" : "写作文件";
    }, [state?.fileName]);

    if (loading) {
        return (
            <div className="grid min-h-screen place-items-center bg-background text-[13px] text-secondary">
                <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载文件…
                </span>
            </div>
        );
    }

    const name = state?.fileName || fallbackName;
    const mime = (state?.mimeType || fallbackMime || "").toLowerCase();
    const ext = extOf(name);
    const isPdf = mime === "application/pdf" || ext === "pdf";
    const isImage = mime.startsWith("image/") || /^(png|jpe?g|webp|gif)$/.test(ext);
    const isText = mime.startsWith("text/") || /^(md|txt|tex|log|json|csv|ya?ml)$/.test(ext);
    const isOffice = /^(docx?|pptx?|xlsx?)$/.test(ext) || mime.includes("officedocument");

    return (
        <div className="flex min-h-screen flex-col bg-background text-foreground">
            <header className="sticky top-0 z-10 border-b border-border-subtle bg-surface/95 px-4 py-2.5 backdrop-blur">
                <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3">
                    <Link
                        href="/research"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        科研工作台
                    </Link>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{name}</div>
                        <div className="text-[11px] text-tertiary">
                            {isOffice ? "Word/Office 文档 · 文本提取预览" : isPdf ? "PDF 文档" : isImage ? "图片" : "文本文件"}
                        </div>
                    </div>
                    {state?.rawUrl && (
                        <a
                            href={state.rawUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
                        >
                            <Download className="h-3.5 w-3.5" />
                            下载原文件
                        </a>
                    )}
                    <button
                        type="button"
                        onClick={() => window.close()}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full p-1.5 text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                        aria-label="关闭标签页"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </header>

            <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-4">
                {error ? (
                    <div className="rounded-xl border border-danger/20 bg-danger/5 p-4 text-[13px] text-danger">{error}</div>
                ) : isImage && state?.rawUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- presigned object URL (not a static asset)
                    <img src={state.rawUrl} alt={name} className="mx-auto max-h-[80vh] rounded-xl border border-border-subtle object-contain" />
                ) : isPdf && state?.rawUrl ? (
                    <iframe
                        src={state.rawUrl}
                        title={name}
                        className="h-[calc(100vh-9rem)] w-full rounded-xl border border-border-subtle bg-surface"
                    />
                ) : (
                    <div className="space-y-3">
                        {isOffice && (
                            <p className="rounded-lg border border-border-subtle bg-border-subtle/40 px-3 py-2 text-[12px] text-secondary">
                                Word/Office 无法在浏览器直接按原版式显示：下面是提取的文本内容；需要版式或继续编辑请点右上角「下载原文件」。
                            </p>
                        )}
                        {state?.preview ? (
                            <>
                                <pre className="max-h-[calc(100vh-11rem)] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-surface p-4 text-[13px] leading-relaxed text-foreground">
                                    {state.preview}
                                </pre>
                                {state.totalChars > state.preview.length && (
                                    <p className="text-[11px] text-tertiary">
                                        已显示前 {state.preview.length} / {state.totalChars} 字，完整内容请下载。
                                    </p>
                                )}
                            </>
                        ) : (
                            <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-secondary">
                                <p className="flex items-center gap-2 font-medium text-foreground">
                                    <FileText className="h-4 w-4" />
                                    该文件暂无可提取的文本内容
                                </p>
                                <p className="mt-1.5 text-[12px] text-tertiary">
                                    {isText ? "请下载后查看。" : "可能是图片型/加密文档，请下载后用对应软件打开。"}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {!error && !isPdf && !isImage && state?.rawUrl && (
                    <div className="mt-3 text-[11px] text-tertiary">
                        <a href={state.rawUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                            在新窗口打开 MinIO 原始文件
                        </a>
                    </div>
                )}
            </main>
        </div>
    );
}

export default function ResearchFilePage() {
    return (
        <Suspense
            fallback={
                <div className="grid min-h-screen place-items-center bg-background text-[13px] text-secondary">加载文件…</div>
            }
        >
            <FileViewer />
        </Suspense>
    );
}
