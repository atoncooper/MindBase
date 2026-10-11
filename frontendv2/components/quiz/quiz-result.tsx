"use client";

/**
 * QuizResult - 提交后的成绩与逐题复盘（Google Material 3 视觉）。
 *
 * 顶部为分数卡：M3 环形分数（Google 蓝/绿）+ 通过状态 chip + 统计行；
 * 下方为逐题复审卡（对/错图标圆 + 题干 + 我的答案/正确答案/解析）。
 */
import { motion } from "framer-motion";
import { ArrowLeft, RefreshCw, Share2, FileDown, Check, X } from "lucide-react";
import type { QuizSetData, QuizSubmissionResult } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

interface QuizResultProps {
    quiz: QuizSetData;
    result: QuizSubmissionResult;
    /** user's submitted answers, keyed by question_uuid (captured at submit) */
    answers: Record<string, string | string[]>;
    onBack: () => void;
    onRetry: () => void;
    /** 打开该题卷的分享弹窗 */
    onShare: () => void;
    /** 打开该题卷的试卷导出弹窗 */
    onExport: () => void;
}

type Answer = string | string[];

function joinAnswer(a: Answer | undefined): string {
    if (!a) return "（未作答）";
    return Array.isArray(a) ? a.join("、") : a;
}

/** M3 风格环形分数（stroke-dasharray 圆环）。 */
function ScoreRing({ pct, passed }: { pct: number; passed: boolean }) {
    const size = 120;
    const stroke = 10;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const filled = (Math.min(100, Math.max(0, pct)) / 100) * c;
    return (
        <svg width={size} height={size} viewBox={"0 0 " + size + " " + size} className="-rotate-90">
            <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke="#dde3ea"
                strokeWidth={stroke}
            />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={passed ? "#188038" : "#d93025"}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={filled + " " + c}
            />
        </svg>
    );
}

export function QuizResult({
    quiz,
    result,
    answers,
    onBack,
    onRetry,
    onShare,
    onExport,
}: QuizResultProps) {
    const pct =
        result.total_count > 0
            ? Math.round((result.correct_count / result.total_count) * 100)
            : 0;
    const passed = result.passed === true;

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.28, 0.11, 0.32, 1] }}
            className="mx-auto w-full max-w-[860px] px-5 py-8 md:px-8"
        >
            <button
                type="button"
                onClick={onBack}
                className="g-btn g-btn-text !px-2"
            >
                <ArrowLeft className="h-4 w-4" />
                返回列表
            </button>

            {/* 分数卡 */}
            <div className="g-card mt-4 flex flex-col items-center gap-6 px-6 py-8 md:flex-row md:px-10">
                <div className="relative grid shrink-0 place-items-center">
                    <ScoreRing pct={pct} passed={passed} />
                    <div className="absolute inset-0 grid place-items-center">
                        <span className="text-[30px] font-semibold tracking-normal text-[#1f1f1f]">
                            {result.score ?? pct}
                        </span>
                    </div>
                </div>
                <div className="min-w-0 flex-1 text-center md:text-left">
                    <p className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                        {quiz.title || "练习结果"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-2 md:justify-start">
                        <span
                            className={cn(
                                "g-chip g-chip-static",
                                passed
                                    ? "!border-transparent !bg-[#e6f4ea] !text-[#188038]"
                                    : "!border-transparent !bg-[#fce8e6] !text-[#d93025]",
                            )}
                        >
                            {passed ? "已通过" : "未通过"}
                        </span>
                        <span className="g-chip g-chip-static">
                            {result.correct_count}/{result.total_count} 题正确
                        </span>
                        <span className="g-chip g-chip-static">难度 {quiz.difficulty}</span>
                    </div>
                    <p className="mt-3 text-[13px] text-[#444746]">
                        正确率 {pct}%，满分 {quiz.total_score > 0 ? quiz.total_score : 100} 分
                    </p>
                </div>
            </div>

            {/* 逐题复盘 */}
            <h2 className="g-section-head mt-8">逐题复盘</h2>
            <div className="mt-4 space-y-5">
                {quiz.questions.map((q, i) => {
                    const r = result.results.find(
                        (x) => x.question_uuid === q.question_uuid,
                    );
                    const correct = r?.is_correct === true;
                    return (
                        <div key={q.question_uuid} className="g-card px-5 py-5 md:px-6">
                            {/* 判定行 */}
                            <div className="flex items-center gap-2.5">
                                <span
                                    className={cn(
                                        "grid h-7 w-7 shrink-0 place-items-center rounded-full",
                                        correct ? "bg-[#e6f4ea] text-[#188038]" : "bg-[#fce8e6] text-[#d93025]",
                                    )}
                                >
                                    {correct ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                                </span>
                                <span className="text-[13px] font-medium text-[#1f1f1f]">
                                    第 {i + 1} 题
                                </span>
                                <span className="text-[11px] text-[#747775]">{q.question_type}</span>
                                <span
                                    className={cn(
                                        "ml-auto text-[12px] font-medium",
                                        correct ? "text-[#188038]" : "text-[#d93025]",
                                    )}
                                >
                                    {correct ? "回答正确" : "回答错误"}
                                </span>
                            </div>

                            {/* 题干 */}
                            <div className="md-body mt-3 text-[15px] leading-relaxed text-[#1f1f1f]">
                                <Markdown>{q.question_text}</Markdown>
                            </div>

                            {/* 我的答案 */}
                            <div className="mt-4 rounded-xl bg-[#f0f4f9] px-4 py-3">
                                <div className="text-[11px] font-medium uppercase tracking-wider text-[#747775]">
                                    我的答案
                                </div>
                                <div className="md-body mt-1 text-[14px] leading-relaxed text-[#1f1f1f]">
                                    <Markdown>{joinAnswer(answers[q.question_uuid])}</Markdown>
                                </div>
                            </div>

                            {/* 正确答案 */}
                            {r?.correct_answer && (
                                <div className="mt-2.5 rounded-xl bg-[#e6f4ea] px-4 py-3">
                                    <div className="text-[11px] font-medium uppercase tracking-wider text-[#188038]">
                                        正确答案
                                    </div>
                                    <div className="md-body mt-1 text-[14px] leading-relaxed text-[#1f1f1f]">
                                        <Markdown>{joinAnswer(r.correct_answer)}</Markdown>
                                    </div>
                                </div>
                            )}

                            {/* 解析 */}
                            {(r?.grading_note || q.explanation) && (
                                <div className="mt-2.5 px-1">
                                    <div className="text-[11px] font-medium uppercase tracking-wider text-[#747775]">
                                        解析
                                    </div>
                                    <div className="md-body mt-1 text-[14px] leading-relaxed text-[#444746]">
                                        <Markdown>{r?.grading_note || q.explanation || ""}</Markdown>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* 底部操作 */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
                <button type="button" onClick={onRetry} className="g-btn g-btn-tonal">
                    <RefreshCw className="h-4 w-4" />
                    再练一次
                </button>
                <button
                    type="button"
                    onClick={onExport}
                    title="导出可打印试卷（docx / PDF / HTML）"
                    className="g-btn g-btn-outlined"
                >
                    <FileDown className="h-4 w-4" />
                    导出试卷
                </button>
                <button
                    type="button"
                    onClick={onShare}
                    title="生成公开链接，任何人可在线查看这份题卷"
                    className="g-btn g-btn-outlined"
                >
                    <Share2 className="h-4 w-4" />
                    分享
                </button>
                <button type="button" onClick={onBack} className="g-btn g-btn-filled ml-auto">
                    返回列表
                </button>
            </div>
        </motion.div>
    );
}
