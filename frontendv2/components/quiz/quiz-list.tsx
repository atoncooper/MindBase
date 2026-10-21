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
import { Plus, BookOpen, Share2, FileDown, ChevronRight, CircleHelp, Loader2, AlertCircle, Search, Check, X, Pencil, Trash2, ArrowUpDown, ChevronDown, RefreshCw } from "lucide-react";
import { quizApi, type QuizHistoryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = [
    { key: "all", label: "全部" },
    { key: "generating", label: "生成中" },
    { key: "unanswered", label: "待作答" },
    { key: "done", label: "已完成" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

const SORT_OPTIONS = [
    { key: "created_desc", label: "最新创建" },
    { key: "created_asc", label: "最早创建" },
    { key: "score_desc", label: "分数最高" },
] as const;

const SORT_LABEL: Record<string, string> = Object.fromEntries(
    SORT_OPTIONS.map((o) => [o.key, o.label]),
);

interface QuizListProps {
    onNew: () => void;
    onSelect: (quizUuid: string) => void;
    /** 打开该题卷的分享弹窗（仅 done 状态的行显示入口） */
    onShare: (quizUuid: string) => void;
    /** 打开该题卷的试卷导出弹窗（仅 done 状态的行显示入口） */
    onExport: (quizUuid: string) => void;
    /** 断点续跑：partial 卷从 checkpoint 补齐剩余题目（仅 partial 行显示入口） */
    onResume: (quizUuid: string) => void;
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

export function QuizList({ onNew, onSelect, onShare, onExport, onResume, refreshKey }: QuizListProps) {
    const [items, setItems] = useState<QuizHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // 生成中项的进度（quiz_uuid → 已落库题数/目标题数）：后台生成的渐进可见
    const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
    // 工具条：搜索 / 状态筛选 / 排序
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [sortBy, setSortBy] = useState<"created_desc" | "created_asc" | "score_desc">("created_desc");
    // 失败自动清理提示（failed = 0 题落库，删除无数据损失）
    const [cleaned, setCleaned] = useState<number | null>(null);
    const [cleanedReason, setCleanedReason] = useState<string | null>(null);
    // 重命名：行内铅笔按钮 → 小对话框；同账号内标题唯一（后端 409 校验）
    const [renaming, setRenaming] = useState<{ uuid: string; title: string } | null>(null);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [renameBusy, setRenameBusy] = useState(false);
    // 删除：垃圾桶按钮 → 确认对话框（生成中的行后端拒绝删除，UI 直接不展示）
    const [deleting, setDeleting] = useState<{ uuid: string; title: string } | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    // 排序：自定义下拉（M3 风格，替代原生 select）
    const [sortOpen, setSortOpen] = useState(false);

    async function saveRename() {
        if (!renaming) return;
        setRenameBusy(true);
        setRenameError(null);
        try {
            await quizApi.renameQuiz(renaming.uuid, renaming.title.trim());
            setRenaming(null);
            void load(true);
        } catch (e) {
            setRenameError(e instanceof Error ? e.message : "重命名失败");
        } finally {
            setRenameBusy(false);
        }
    }

    async function confirmDelete() {
        if (!deleting || deleteBusy) return;
        setDeleteBusy(true);
        try {
            await quizApi.deleteQuiz(deleting.uuid);
            setDeleting(null);
            void load(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除失败");
            setDeleting(null);
        } finally {
            setDeleteBusy(false);
        }
    }

    const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        setError(null);
        try {
            const res = await quizApi.getHistory(1, 30);
            // Newest first。failed 项保留展示（后台生成模式下失败必须留痕可查）。
            const sorted = [...res.submissions].sort((a, b) =>
                (b.submitted_at ?? b.created_at ?? "").localeCompare(
                    a.submitted_at ?? a.created_at ?? "",
                ),
            );
            // 失败自动清理：failed 终态 = 无已落库题目，直接删除（用户要求，避免堆积）
            const failed = sorted.filter((it) => it.status === "failed");
            if (failed.length > 0) {
                // 保留第一条失败原因用于横幅展示（清理后记录即删，原因必须先取出）
                setCleanedReason(failed.find((it) => it.error_message)?.error_message ?? null);
                void Promise.allSettled(failed.map((it) => quizApi.deleteQuiz(it.quiz_uuid))).then(() => {
                    setCleaned((prev) => (prev ?? 0) + failed.length);
                });
            }
            const failedUuids = new Set(failed.map((it) => it.quiz_uuid));
            setItems(sorted.filter((it) => !failedUuids.has(it.quiz_uuid)));
            // 生成中项（最多 3 个）拉取 checkpoint 进度 n/N
            const generating = sorted.filter((it) => it.status === "generating").slice(0, 3);
            if (generating.length === 0) {
                setProgress({});
                return;
            }
            const entries = await Promise.all(
                generating.map(async (it) => {
                    try {
                        const q = await quizApi.getQuiz(it.quiz_uuid);
                        return [it.quiz_uuid, { done: q.questions.length, total: q.question_count }] as const;
                    } catch {
                        return null;
                    }
                }),
            );
            setProgress(Object.fromEntries(entries.filter((x): x is NonNullable<typeof x> => x !== null)));
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载历史失败");
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, refreshKey]);

    // 存在生成中项时轻量自动刷新，全部落定后停止
    const hasGenerating = items.some((it) => it.status === "generating");
    useEffect(() => {
        if (!hasGenerating) return;
        const t = setInterval(() => void load(true), 8000);
        return () => clearInterval(t);
    }, [hasGenerating, load]);

    // 客户端过滤 + 排序（单页 ≤30 条，无需后端参数）
    const visible = (() => {
        let list = items;
        const q = query.trim().toLowerCase();
        if (q) list = list.filter((it) => (it.title || "").toLowerCase().includes(q));
        if (statusFilter === "generating") list = list.filter((it) => it.status === "generating");
        else if (statusFilter === "done") list = list.filter((it) => it.status === "done");
        else if (statusFilter === "unanswered") list = list.filter((it) => it.status !== "generating" && it.score == null);
        const key = (it: QuizHistoryItem) => it.submitted_at ?? it.created_at ?? "";
        if (sortBy === "score_desc") return [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return [...list].sort((a, b) =>
            sortBy === "created_asc" ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a)),
        );
    })();

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

            {/* 工具条：搜索 + 排序 + 状态筛选 */}
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
                <div className="relative min-w-[170px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#747775]" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索标题…"
                        className="g-field !pl-9"
                    />
                </div>
                <div className="relative shrink-0">
                    <button
                        type="button"
                        onClick={() => setSortOpen((o) => !o)}
                        aria-haspopup="listbox"
                        aria-expanded={sortOpen}
                        className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-[#c4c7c5] bg-white px-3 text-[13px] text-[#1f1f1f] transition-colors hover:bg-[rgba(31,31,31,0.03)]"
                    >
                        <ArrowUpDown className="h-3.5 w-3.5 text-[#747775]" />
                        {SORT_LABEL[sortBy]}
                        <ChevronDown className={cn("h-3.5 w-3.5 text-[#747775] transition-transform", sortOpen && "rotate-180")} />
                    </button>
                    {sortOpen && (
                        <>
                            <div className="fixed inset-0 z-[60]" onClick={() => setSortOpen(false)} />
                            <div
                                className="absolute right-0 z-[61] mt-1 w-[150px] overflow-hidden rounded-xl border border-[#c4c7c5] bg-white py-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
                                role="listbox"
                            >
                                {SORT_OPTIONS.map((o) => (
                                    <button
                                        key={o.key}
                                        type="button"
                                        onClick={() => {
                                            setSortBy(o.key);
                                            setSortOpen(false);
                                        }}
                                        className={cn(
                                            "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors hover:bg-[rgba(31,31,31,0.04)]",
                                            sortBy === o.key ? "font-medium text-[#0b57d0]" : "text-[#1f1f1f]",
                                        )}
                                    >
                                        {o.label}
                                        {sortBy === o.key && <Check className="h-3.5 w-3.5" />}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
                <div className="g-segmented shrink-0">
                    {STATUS_FILTERS.map((f) => (
                        <button
                            key={f.key}
                            type="button"
                            className={statusFilter === f.key ? "g-seg-active" : undefined}
                            onClick={() => setStatusFilter(f.key)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {cleaned != null && (
                <div className="g-banner mt-3">
                    <Check className="h-4 w-4 shrink-0 text-[#188038]" />
                    <span className="flex-1 truncate" title={cleanedReason ?? undefined}>
                        已自动清理 {cleaned} 份生成失败的空题卷{cleanedReason ? `（原因：${cleanedReason}）` : ""}
                    </span>
                    <button
                        type="button"
                        onClick={() => setCleaned(null)}
                        className="g-icon-btn !h-6 !w-6"
                        aria-label="关闭提示"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {/* 列表 */}
            <div className="mt-6">
                {loading ? (
                    <ListSkeleton />
                ) : error ? (
                    <div className="g-card px-5 py-8 text-center text-[13px] text-[#444746]">{error}</div>
                ) : visible.length === 0 ? (
                    items.length === 0 ? (
                        <EmptyState onNew={onNew} />
                    ) : (
                        <div className="g-card px-5 py-8 text-center text-[13px] text-[#444746]">没有匹配的练习</div>
                    )
                ) : (
                    <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25 }}
                        className="g-card divide-y divide-[#c4c7c5] overflow-hidden"
                    >
                        {visible.map((it) => (
                            <div
                                key={it.quiz_uuid + (it.submission_uuid ?? "")}
                                className="group flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 px-3 py-2.5 transition-colors hover:bg-[rgba(31,31,31,0.03)] md:flex-nowrap md:justify-start md:gap-y-3 md:px-4"
                            >
                                <button
                                    type="button"
                                    onClick={() => onSelect(it.quiz_uuid)}
                                    className="flex min-w-0 flex-1 basis-full items-center gap-3.5 rounded-xl px-1 py-1.5 text-left md:basis-0"
                                >
                                    <span className="g-lead-icon">
                                        <BookOpen className="h-[18px] w-[18px]" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[15px] font-medium text-[#1f1f1f]">
                                            {it.title || "未命名练习"}
                                        </span>
                                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[#444746]">
                                            {it.status === "generating" && (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[11px] font-medium text-[#0b57d0]">
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                    生成中{progress[it.quiz_uuid] ? ` ${progress[it.quiz_uuid].done}/${progress[it.quiz_uuid].total}` : "…"}
                                                </span>
                                            )}
                                            {it.status === "failed" && (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-[#fce8e6] px-2 py-0.5 text-[11px] font-medium text-[#d93025]">
                                                    <AlertCircle className="h-3 w-3" />
                                                    生成失败
                                                </span>
                                            )}
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
                                {it.status !== "generating" && (
                                    <button
                                        type="button"
                                        title="删除练习"
                                        aria-label="删除练习"
                                        onClick={() => setDeleting({ uuid: it.quiz_uuid, title: it.title || "未命名练习" })}
                                        className="g-icon-btn !h-9 !w-9 shrink-0 hover:!text-[#d93025]"
                                    >
                                        <Trash2 className="h-[15px] w-[15px]" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    title="重命名"
                                    aria-label="重命名"
                                    onClick={() => {
                                        setRenameError(null);
                                        setRenaming({ uuid: it.quiz_uuid, title: it.title || "" });
                                    }}
                                    className="g-icon-btn !h-9 !w-9 shrink-0"
                                >
                                    <Pencil className="h-[15px] w-[15px]" />
                                </button>
                                {it.status === "partial" && (
                                    <button
                                        type="button"
                                        title="继续生成：从断点补齐剩余题目（已保留部分不受影响）"
                                        aria-label="继续生成"
                                        onClick={() => onResume(it.quiz_uuid)}
                                        className="g-icon-btn !h-9 !w-9 shrink-0"
                                    >
                                        <RefreshCw className="h-[15px] w-[15px]" />
                                    </button>
                                )}
                                {(it.status === "done" || it.status === "partial") && (
                                    <>
                                        <button
                                            type="button"
                                            title={it.status === "partial" ? "导出试卷（部分生成，含已出题目）" : "导出试卷"}
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

            {/* 重命名对话框：同账号内标题唯一（后端 409） */}
            {renaming && (
                <div
                    className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(32,33,36,0.5)]"
                    onClick={() => setRenaming(null)}
                >
                    <div
                        className="g-card w-[calc(100vw_-_2rem)] max-w-[420px] p-6"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="text-[16px] font-medium text-[#1f1f1f]">重命名练习</p>
                        <input
                            autoFocus
                            value={renaming.title}
                            maxLength={60}
                            onChange={(e) => {
                                setRenaming({ ...renaming, title: e.target.value });
                                setRenameError(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && renaming.title.trim()) void saveRename();
                            }}
                            className="g-field mt-4"
                            placeholder="标题（同账号内不可重名）"
                        />
                        {renameError && (
                            <p className="mt-2 text-[12px] text-[#d93025]">{renameError}</p>
                        )}
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                className="g-btn g-btn-text"
                                onClick={() => setRenaming(null)}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="g-btn g-btn-filled"
                                disabled={!renaming.title.trim() || renameBusy}
                                onClick={() => void saveRename()}
                            >
                                {renameBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 删除确认对话框 */}
            {deleting && (
                <div
                    className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(32,33,36,0.5)]"
                    onClick={() => (deleteBusy ? undefined : setDeleting(null))}
                >
                    <div
                        className="g-card w-[calc(100vw_-_2rem)] max-w-[400px] p-6"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2">
                            <span className="grid h-8 w-8 place-items-center rounded-full bg-[#fce8e6] text-[#d93025]">
                                <AlertCircle className="h-4 w-4" />
                            </span>
                            <p className="text-[16px] font-medium text-[#1f1f1f]">删除练习</p>
                        </div>
                        <p className="mt-3 text-[13px] leading-relaxed text-[#444746]">
                            将删除「{deleting.title}」及其全部题目、作答记录与分享链接，
                            <span className="font-medium text-[#d93025]">此操作不可恢复</span>。
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                className="g-btn g-btn-text"
                                onClick={() => setDeleting(null)}
                                disabled={deleteBusy}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={() => void confirmDelete()}
                                disabled={deleteBusy}
                                className="g-btn g-btn-filled !bg-[#d93025] hover:!bg-[#b3261e]"
                            >
                                {deleteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                                确认删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
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
