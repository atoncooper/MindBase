"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { notesApi, type NoteSharedView } from "@/lib/api";
import "@/components/dock-modules/notes/notes.css";

export default function SharedNotePage() {
    const params = useParams<{ token: string }>();
    const token = params?.token;
    const [note, setNote] = useState<NoteSharedView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!token) return;
        setLoading(true);
        notesApi
            .getShared(token)
            .then((data) => setNote(data))
            .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "加载失败");
            })
            .finally(() => setLoading(false));
    }, [token]);

    if (loading) {
        return (
            <div className="notes-reading notes-reading-center">
                <div className="flex flex-col items-center gap-3">
                    <div className="note-fleuron-lg">❦</div>
                    <span className="note-eyebrow">Loading</span>
                </div>
            </div>
        );
    }

    if (error || !note) {
        return (
            <div className="notes-reading notes-reading-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="note-404">404</div>
                    <div className="note-eyebrow">Not Found</div>
                    <div className="note-404-msg">分享不存在或已失效</div>
                </div>
            </div>
        );
    }

    // Reading stats for the colophon - strip markdown noise + whitespace.
    const stripped = note.contentMd
        ? note.contentMd
              .replace(/```[\s\S]*?```/g, "")
              .replace(/`[^`]*`/g, "")
              .replace(/[#*_>\-\[\]()!]/g, "")
              .replace(/\s/g, "")
        : "";
    const charCount = stripped.length;
    const readingMinutes = charCount > 0 ? Math.max(1, Math.round(charCount / 350)) : 0;

    return (
        <div className="notes-reading">
            <div className="py-16 px-4">
                <article
                    className="note-article max-w-3xl mx-auto p-12 md:p-16 note-fade-in"
                    style={{ animationDuration: "480ms" }}
                >
                    <header className="mb-10">
                        <div className="note-eyebrow note-eyebrow-lg">
                            <span className="note-fleuron">❦</span>
                            A Note from MindBase
                        </div>
                        <h1 className="note-article-title">{note.title || "无标题"}</h1>
                        <div className="note-title-rule" />
                        <div className="note-article-meta">
                            <span>
                                {new Date(note.sharedAt).toLocaleDateString("zh-CN", {
                                    year: "numeric",
                                    month: "long",
                                    day: "numeric",
                                })}
                            </span>
                            <span className="note-meta-sep">❧</span>
                            <span>{note.viewCount} 次浏览</span>
                        </div>
                    </header>

                    <div className="note-preview note-article-body">
                        {note.contentMd ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {note.contentMd}
                            </ReactMarkdown>
                        ) : (
                            <p className="note-empty-body">（空笔记）</p>
                        )}
                    </div>

                    <footer className="note-colophon">
                        <span className="note-colophon-mark">❦</span>
                        <span>经 MindBase 分享</span>
                        <span className="note-stat">
                            <span className="note-stat-mark">❧</span>
                            {charCount} 字
                        </span>
                        {readingMinutes > 0 && (
                            <span className="note-stat">
                                <span className="note-stat-mark">❧</span>
                                约 {readingMinutes} 分钟
                            </span>
                        )}
                    </footer>
                </article>
            </div>
        </div>
    );
}
