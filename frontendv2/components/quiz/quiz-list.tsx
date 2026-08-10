"use client";

/**
 * QuizList - history list + "new practice" entry.
 *
 * Loads submission history (quizApi.getHistory) and renders a flat list of
 * rows divided by hairlines (Apple Settings/Mail style). Each row opens the
 * quiz for re-practice. An empty state and a skeleton loader are handled.
 */
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Plus, BookOpen } from "lucide-react";
import { quizApi, type QuizHistoryItem } from "@/lib/api";

interface QuizListProps {
    onNew: () => void;
    onSelect: (quizUuid: string) => void;
    /** bump to force a reload after a new quiz is generated */
    refreshKey: number;
}

function formatTime(iso?: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
    ).padStart(2, "0")}`;
    return sameYear ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}

export function QuizList({ onNew, onSelect, refreshKey }: QuizListProps) {
    const [items, setItems] = useState<QuizHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await quizApi.getHistory(1, 30);
            // Newest first.
            // Drop failed quizzes - they have no questions to practice.
            const sorted = [...res.submissions]
                .filter((it) => it.status !== "failed")
                .sort((a, b) =>
                    (b.submitted_at ?? b.created_at ?? "").localeCompare(
                        a.submitted_at ?? a.created_at ?? "",
                    ),
                );
            setItems(sorted);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载历史失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load, refreshKey]);

    return (
        <div className="mx-auto max-w-[760px] px-5 py-8 md:px-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                        题目练习
                    </h1>
                    <p className="mt-0.5 text-[13px] text-secondary">
                        基于收藏夹知识库生成的题目，可反复练习
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onNew}
                    className="btn-pill btn-primary h-9 px-4 text-[13px]"
                >
                    <Plus className="h-4 w-4" />
                    新建练习
                </button>
            </div>

            {/* List */}
            <div className="mt-6">
                {loading ? (
                    <ListSkeleton />
                ) : error ? (
                    <div className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-[13px] text-secondary">
                        {error}
                    </div>
                ) : items.length === 0 ? (
                    <EmptyState onNew={onNew} />
                ) : (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.3 }}
                        className="overflow-hidden rounded-2xl border border-border bg-surface"
                    >
                        {items.map((it, i) => (
                            <button
                                key={it.quiz_uuid + (it.submission_uuid ?? "")}
                                type="button"
                                onClick={() => onSelect(it.quiz_uuid)}
                                className={`flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-border-subtle ${
                                    i > 0 ? "border-t border-border-subtle" : ""
                                }`}
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-[15px] font-medium text-foreground">
                                        {it.title || "未命名练习"}
                                    </p>
                                    <p className="mt-0.5 text-[12px] text-tertiary">
                                        {it.submitted_at
                                            ? formatTime(it.submitted_at)
                                            : it.created_at
                                              ? formatTime(it.created_at)
                                              : "未作答"}
                                    </p>
                                </div>
                                <div className="shrink-0 text-right">
                                    {it.score != null ? (
                                        <>
                                            <p className="text-[17px] font-semibold tracking-tight text-foreground">
                                                {it.correct_count}/
                                                {it.total_question_count}
                                            </p>
                                            <p className="text-[11px] text-tertiary">
                                                {it.difficulty ?? ""}
                                            </p>
                                        </>
                                    ) : (
                                        <p className="text-[13px] text-secondary">
                                            未作答
                                        </p>
                                    )}
                                </div>
                            </button>
                        ))}
                    </motion.div>
                )}
            </div>
        </div>
    );
}

function ListSkeleton() {
    return (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            {Array.from({ length: 4 }).map((_, i) => (
                <div
                    key={i}
                    className={`flex items-center gap-4 px-5 py-4 ${
                        i > 0 ? "border-t border-border-subtle" : ""
                    }`}
                >
                    <div className="h-4 flex-1 animate-pulse rounded bg-border-subtle" />
                    <div className="h-5 w-10 animate-pulse rounded bg-border-subtle" />
                </div>
            ))}
        </div>
    );
}

function EmptyState({ onNew }: { onNew: () => void }) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-6 py-14 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-border-subtle">
                <BookOpen className="h-6 w-6 text-tertiary" />
            </div>
            <p className="text-[15px] font-medium text-foreground">还没有练习记录</p>
            <p className="text-[13px] text-secondary">
                选择收藏夹生成一套题目，开始练习
            </p>
            <button
                type="button"
                onClick={onNew}
                className="btn-pill btn-primary mt-2 h-9 px-5 text-[13px]"
            >
                <Plus className="h-4 w-4" />
                新建练习
            </button>
        </div>
    );
}
