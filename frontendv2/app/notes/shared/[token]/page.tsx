"use client";

/**
 * Public shared-note reading page. No auth, no NavBar - a clean, centered
 * article view. Route is whitelisted in RouteGuard (PUBLIC_PREFIXES).
 */
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Loader2, AlertCircle, BookOpen } from "lucide-react";
import { notesApi, type NoteSharedView } from "@/lib/api/notes";

export default function SharedNotePage() {
    const [data, setData] = useState<NoteSharedView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // token is the last path segment.
        const token = window.location.pathname.split("/").pop() ?? "";
        if (!token) {
            /* eslint-disable react-hooks/set-state-in-effect */
            setError("链接无效");
            setLoading(false);
            /* eslint-enable react-hooks/set-state-in-effect */
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const view = await notesApi.getShared(token);
                if (!cancelled) {
                    setData(view);
                    setLoading(false);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "分享不存在或已失效");
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <Loader2 className="h-6 w-6 animate-spin text-tertiary" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/5 text-danger">
                    <AlertCircle className="h-6 w-6" />
                </span>
                <p className="mt-4 text-[15px] font-medium text-foreground">
                    {error ?? "分享不存在"}
                </p>
                <p className="mt-1.5 text-[13px] text-secondary">
                    这条分享链接可能已过期或被撤销。
                </p>
            </div>
        );
    }

    return (
        <article className="min-h-screen bg-background">
            <div className="mx-auto max-w-[720px] px-6 py-16 sm:px-10">
                <div className="mb-8 flex items-center gap-2 text-[11px] uppercase tracking-wider text-tertiary">
                    <BookOpen className="h-3 w-3" />
                    <span>MindBase · 公开分享</span>
                </div>
                <h1 className="text-[34px] font-semibold leading-tight tracking-tight text-foreground">
                    {data.title || "无标题"}
                </h1>
                <p className="mt-3 text-[12px] text-secondary">
                    {new Date(data.sharedAt).toLocaleDateString("zh-CN", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                    })}
                </p>
                <hr className="my-8 border-border" />
                <div className="note-prose">
                    {data.contentMd.trim() ? (
                        <Markdown>{data.contentMd}</Markdown>
                    ) : (
                        <p className="text-secondary">这篇笔记暂无内容。</p>
                    )}
                </div>
            </div>
        </article>
    );
}
