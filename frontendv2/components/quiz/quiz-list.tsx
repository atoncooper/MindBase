"use client";

/**
 * QuizList - 历史列表 + 新建练习入口（Google Material 3 视觉）。
 *
 * Google Classroom 风格：页面标题区 + 实色 pill 主按钮；列表为白底
 * outlined 卡片行，leading 主色圆图标、trailing 分数/chip/操作图标按钮。
 * 加载态用 g-skeleton 闪烁骨架。
 */
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Plus, BookOpen, Share2, FileDown, ChevronRight, CircleHelp } from "lucide-react";
import { quizApi, type QuizHistoryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

interface QuizListProps {
    onNew: () => void;
    onSelect: (quizUuid: string) => void;
    /** 打开该题卷的分享弹窗（仅 done 状态的行显示入口） */
    onShare: (quizUuid: string) => void;
    /** 打开该题卷的试卷导出弹窗（仅 done 状态的行显示入口） */
    onExport: (quizUuid: string) => void;
    /** bump to force a reload after a new quiz is generated */
    refreshKey: number;
}

const DIFF_LABEL: Record<string, string> = {
    easy: "简单",
    medium: "中等",
    hard: "困难",
};

function formatTime(iso?: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const md = d.getMonth() + 1 + "月" + d.getDate() + "日";
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    return sameYear ? md + " " + hm : d.getFullYear() + "年" + md;
}

export function QuizList({ onNew, onSelect, onShare, onExport, refreshKey }: QuizListProps) {
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
        <div className="mx-auto w-full max-w-[860px] px-5 py-8 md:px-8">
            {/* 页头：标题区 + 主操作（Google Classroom 式） */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-[26px] font-semibold leading-tight tracking-normal text-[#1f1f1f]">
                        题目练习
                    </h1>
                    <p className="mt-1 text-[14px] text-[#444746]">
                        基于收藏夹知识库 / AI 生成的题目，可反复练习并导出打印
                    </p>
                </div>
                <button type="button" onClick={onNew} className="g-btn g-btn-filled">
                    <Plus className="h-[18px] w-[18px]" />
                    新建练习
                </button>
            </div>

            {/* 列表 */}
            <div className="mt-6">
                {loading ? (
                    <ListSkeleton />
                ) : error ? (
                    <div className="g-card px-5 py-8 text-center text-[13px] text-[#444746]">{error}</div>
                ) : items.length === 0 ? (
                    <EmptyState onNew={onNew} />
                ) : (
                    <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25 }}
                        className="g-card divide-y divide-[#c4c7c5] overflow-hidden"
                    >
                        {items.map((it) => (
                            <div
                                key={it.quiz_uuid + (it.submission_uuid ?? "")}
                                className="group flex w-full items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[rgba(31,31,31,0.03)] md:px-4"
                            >
                                <button
                                    type="button"
                                    onClick={() => onSelect(it.quiz_uuid)}
                                    className="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl px-1 py-1.5 text-left"
                                >
                                    <span className="g-lead-icon">
                                        <BookOpen className="h-[18px] w-[18px]" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[15px] font-medium text-[#1f1f1f]">
                                            {it.title || "未命名练习"}
                                        </span>
                                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[#444746]">
                                            <span>
                                                {it.submitted_at
                                                    ? "作答于 " + formatTime(it.submitted_at)
                                                    : it.created_at
                                                      ? "创建于 " + formatTime(it.created_at)
                                                      : "未作答"}
                                            </span>
                                            {it.difficulty && (
                                                <span className="text-[#747775]">· {DIFF_LABEL[it.difficulty] ?? it.difficulty}</span>
                                            )}
                                            {it.source_type && String(it.source_type).startsWith("ai_") && (
                                                <span className="text-[#747775]">· AI 出题</span>
                                            )}
                                        </span>
                                    </span>
                                    <span className="hidden shrink-0 text-right md:block">
                                        {it.score != null ? (
                                            <>
                                                <span
                                                    className={cn(
                                                        "text-[18px] font-semibold tracking-normal",
                                                        it.passed ? "text-[#188038]" : "text-[#d93025]",
                                                    )}
                                                >
                                                    {it.correct_count}/{it.total_question_count}
                                                </span>
                                                <span className="block text-[11px] text-[#444746]">
                                                    {it.passed ? "已通过" : "未通过"}
                                                </span>
                                            </>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 text-[12px] text-[#747775]">
                                                <CircleHelp className="h-3.5 w-3.5" />
                                                待作答
                                            </span>
                                        )}
                                    </span>
                                    <ChevronRight className="hidden h-4 w-4 shrink-0 text-[#747775] md:block" />
                                </button>
                                {it.status === "done" && (
                                    <>
                                        <button
                                            type="button"
                                            title="导出试卷"
                                            aria-label="导出试卷"
                                            onClick={() => onExport(it.quiz_uuid)}
                                            className="g-icon-btn !h-9 !w-9 shrink-0"
                                        >
                                            <FileDown className="h-[17px] w-[17px]" />
                                        </button>
                                        <button
                                            type="button"
                                            title="分享题卷"
                                            aria-label="分享题卷"
                                            onClick={() => onShare(it.quiz_uuid)}
                                            className="g-icon-btn !h-9 !w-9 shrink-0"
                                        >
                                            <Share2 className="h-[17px] w-[17px]" />
                                        </button>
                                    </>
                                )}
                            </div>
                        ))}
                    </motion.div>
                )}
            </div>
        </div>
    );
}

function ListSkeleton() {
    return (
        <div className="g-card divide-y divide-[#c4c7c5] overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-4">
                    <div className="g-skeleton h-10 w-10 rounded-full" />
                    <div className="flex-1 space-y-2">
                        <div className="g-skeleton h-4 w-2/5" />
                        <div className="g-skeleton h-3 w-1/4" />
                    </div>
                    <div className="g-skeleton h-5 w-10" />
                </div>
            ))}
        </div>
    );
}

function EmptyState({ onNew }: { onNew: () => void }) {
    return (
        <div className="g-card flex flex-col items-center gap-3 px-6 py-14 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-[#d3e3fd]">
                <BookOpen className="h-7 w-7 text-[#041e49]" />
            </div>
            <p className="text-[16px] font-medium text-[#1f1f1f]">还没有练习记录</p>
            <p className="max-w-[320px] text-[13px] leading-relaxed text-[#444746]">
                选择收藏夹、输入主题或上传错题图片，AI 为你生成一套可练习、可打印的题目
            </p>
            <button type="button" onClick={onNew} className="g-btn g-btn-tonal mt-2">
                <Plus className="h-4 w-4" />
                新建练习
            </button>
        </div>
    );
}
