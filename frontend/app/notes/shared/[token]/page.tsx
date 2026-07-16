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
            <div
                className="min-h-screen flex items-center justify-center"
                style={{
                    background: "#faf8f3",
                    color: "#a8a39b",
                    fontFamily: '"Hanken Grotesk", sans-serif',
                    fontStyle: "italic",
                }}
            >
                <div className="flex flex-col items-center gap-3">
                    <div
                        style={{
                            fontFamily: '"Fraunces", Georgia, serif',
                            fontStyle: "italic",
                            fontSize: 40,
                            color: "#c4b89f",
                            opacity: 0.6,
                        }}
                    >
                        ❦
                    </div>
                    <span style={{ fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600 }}>
                        Loading
                    </span>
                </div>
            </div>
        );
    }

    if (error || !note) {
        return (
            <div
                className="min-h-screen flex flex-col items-center justify-center gap-4"
                style={{
                    background: "#faf8f3",
                    color: "#54545a",
                    fontFamily: '"Hanken Grotesk", sans-serif',
                }}
            >
                <div
                    style={{
                        fontFamily: '"Fraunces", Georgia, serif',
                        fontSize: 88,
                        fontStyle: "italic",
                        color: "#c4b89f",
                        opacity: 0.55,
                        lineHeight: 1,
                        fontVariationSettings: '"opsz" 144',
                    }}
                >
                    404
                </div>
                <div
                    style={{
                        fontSize: 10,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        fontWeight: 600,
                        color: "#a8a39b",
                    }}
                >
                    Not Found
                </div>
                <div style={{ fontSize: 14, fontFamily: '"Fraunces", Georgia, serif', fontStyle: "italic" }}>
                    {error || "分享不存在或已失效"}
                </div>
            </div>
        );
    }

    // Reading stats for the colophon — strip markdown noise + whitespace.
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
                        <div
                            style={{
                                fontFamily: "var(--note-sans)",
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.2em",
                                textTransform: "uppercase",
                                color: "var(--note-folio)",
                                marginBottom: 18,
                            }}
                        >
                            <span style={{ fontStyle: "italic", fontFamily: "var(--note-serif)", textTransform: "none", letterSpacing: 0, fontSize: 14, marginRight: 8, color: "var(--note-accent)" }}>
                                ❦
                            </span>
                            A Note from MindBase
                        </div>
                        <h1
                            style={{
                                fontFamily: "var(--note-serif)",
                                fontSize: 44,
                                fontWeight: 500,
                                letterSpacing: "-0.022em",
                                lineHeight: 1.12,
                                color: "var(--note-ink)",
                                fontVariationSettings: '"opsz" 144',
                            }}
                        >
                            {note.title || "无标题"}
                        </h1>
                        <div
                            style={{
                                width: 56,
                                height: 1,
                                background: "var(--note-ink)",
                                opacity: 0.65,
                                marginTop: 22,
                            }}
                        />
                        <div
                            className="flex flex-wrap items-center gap-3 mt-5"
                            style={{
                                color: "var(--note-ink-faint)",
                                fontFamily: "var(--note-sans)",
                                fontSize: 11,
                                fontWeight: 600,
                                letterSpacing: "0.14em",
                                textTransform: "uppercase",
                            }}
                        >
                            <span>
                                {new Date(note.sharedAt).toLocaleDateString("zh-CN", {
                                    year: "numeric",
                                    month: "long",
                                    day: "numeric",
                                })}
                            </span>
                            <span style={{ fontFamily: "var(--note-serif)", fontStyle: "italic", textTransform: "none", letterSpacing: 0, fontSize: 11, color: "var(--note-folio)" }}>
                                ❧
                            </span>
                            <span>{note.viewCount} 次浏览</span>
                        </div>
                    </header>

                    <div
                        className="note-preview note-article-body"
                        style={{
                            fontFamily: "var(--note-sans)",
                            fontSize: 16.5,
                            lineHeight: 1.85,
                            color: "var(--note-ink)",
                        }}
                    >
                        {note.contentMd ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {note.contentMd}
                            </ReactMarkdown>
                        ) : (
                            <p
                                style={{
                                    color: "var(--note-ink-faint)",
                                    fontStyle: "italic",
                                    fontFamily: "var(--note-serif)",
                                }}
                            >
                                （空笔记）
                            </p>
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
