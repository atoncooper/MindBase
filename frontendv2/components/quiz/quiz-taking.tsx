"use client";

/**
 * QuizTaking - 作答流程（Google Material 3 视觉）。
 *
 * 两种模式共享同一份 answers 与提交入口：
 *   practice 逐题模式：顶部 M3 线性进度 + 单题卡片（题型 chip + 选项卡 + 文本域）
 *   paper    整卷模式：QuizPaperTaking 整卷作答
 * 头部为返回 + 标题 + 分段控件；底部为上一题/下一题/交卷。
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, AlertCircle, ClipboardList, Check } from "lucide-react";
import { quizApi, type QuizSetData, type QuizSubmissionResult } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { QuizPaperTaking } from "./quiz-paper-taking";
import { cn } from "@/lib/utils";

interface QuizTakingProps {
    quiz: QuizSetData;
    onBack: () => void;
    onSubmitted: (
        result: QuizSubmissionResult,
        answers: Record<string, string | string[]>,
    ) => void;
}

type AnswerMap = Record<string, string | string[]>;

const TYPE_LABEL: Record<string, string> = {
    single_choice: "单项选择",
    multi_choice: "多项选择",
    short_answer: "简答",
    essay: "论述",
};

/** 提取选项标签（A/B/…），无前缀时按下标生成。 */
function optionParts(opt: string, index: number): { label: string; text: string } {
    const m = /^\s*([A-Za-z])(?:[.．、\s]+|$)/.exec(opt);
    const label = m ? m[1].toUpperCase() : String.fromCharCode("A".charCodeAt(0) + index);
    const text = m ? opt.replace(/^\s*[A-Za-z](?:[.．、\s]+)/, "").trim() : opt;
    return { label, text: text || opt };
}

export function QuizTaking({ quiz, onBack, onSubmitted }: QuizTakingProps) {
    const questions = quiz.questions;
    const total = questions.length;
    // 后台生成中的题卷：允许作答已出的题，交卷在生成完成（done/partial 终态）后开放
    const generating = quiz.status === "generating";
    const genTotal = quiz.question_count;
    const [current, setCurrent] = useState(0);
    const [answers, setAnswers] = useState<AnswerMap>({});
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 练习（逐题）/ 试卷（整卷）两种作答方式；同一份 answers + 同一提交入口
    const [mode, setMode] = useState<"practice" | "paper">("practice");
    // Lazy init captures the start time once on mount.
    const [startedAt] = useState(() => Date.now());

    const q = questions[current];
    // Defensive: a quiz may have no questions yet (still generating, failed,
    // or data lost). All hooks above already ran, so an early return here is
    // safe under rules-of-hooks.
    if (!q) {
        return (
            <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
                <div className="grid h-14 w-14 place-items-center rounded-full bg-[#d3e3fd]">
                    <ClipboardList className="h-7 w-7 text-[#041e49]" />
                </div>
                <p className="text-[16px] font-medium text-[#1f1f1f]">该题卷暂无题目</p>
                <p className="text-[13px] text-[#444746]">题目可能仍在生成或已失败，请稍后重试</p>
                <button type="button" onClick={onBack} className="g-btn g-btn-tonal mt-2">
                    返回列表
                </button>
            </div>
        );
    }
    const isSingle = q.question_type === "single_choice";
    const isMulti = q.question_type === "multi_choice";
    const isChoice = isSingle || isMulti;

    function setSingle(uuid: string, opt: string) {
        setAnswers((prev) => ({ ...prev, [uuid]: opt }));
    }
    function toggleMulti(uuid: string, opt: string) {
        setAnswers((prev) => {
            const prevArr = Array.isArray(prev[uuid]) ? (prev[uuid] as string[]) : [];
            const next = prevArr.includes(opt)
                ? prevArr.filter((x) => x !== opt)
                : [...prevArr, opt];
            return { ...prev, [uuid]: next };
        });
    }
    function setText(uuid: string, text: string) {
        setAnswers((prev) => ({ ...prev, [uuid]: text }));
    }

    async function submit() {
        if (generating) return; // 半卷不可交：等生成终态（done/partial）
        setSubmitting(true);
        setError(null);
        try {
            const answerItems = questions.map((qq) => ({
                question_uuid: qq.question_uuid,
                answer: answers[qq.question_uuid] ?? "",
            }));
            const timeSpent = Math.round((Date.now() - startedAt) / 1000);
            const result = await quizApi.submit({
                quiz_uuid: quiz.quiz_uuid,
                answers: answerItems,
                time_spent_seconds: timeSpent,
            });
            onSubmitted(result, answers);
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交批改失败");
        }
        setSubmitting(false);
    }

    const progressPct = total > 0 ? ((current + 1) / total) * 100 : 0;
    const myAnswer = answers[q.question_uuid];
    const activeMulti = isMulti && Array.isArray(myAnswer) ? (myAnswer as string[]) : [];
    const answeredCount = Object.keys(answers).filter((k) => {
        const v = answers[k];
        return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim().length > 0;
    }).length;

    return (
        <div className="mx-auto flex h-[calc(100dvh_-_7.75rem_-_env(safe-area-inset-bottom))] w-full max-w-[860px] flex-col px-5 md:h-[calc(100dvh-4rem)] md:px-8">
            {/* Header */}
            <div className="flex items-center gap-2.5 pt-5">
                <button
                    type="button"
                    onClick={onBack}
                    className="g-icon-btn shrink-0"
                    aria-label="返回"
                >
                    <ArrowLeft className="h-[18px] w-[18px]" />
                </button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-semibold tracking-normal text-[#1f1f1f]">
                        {quiz.title || "题目练习"}
                    </p>
                    <p className="text-[12px] text-[#444746]">
                        {mode === "paper"
                            ? "整卷作答 · 共 " + total + " 题"
                            : "第 " + (current + 1) + " / " + total + " 题 · 难度 " + q.difficulty}
                    </p>
                </div>
                <div className="g-segmented shrink-0">
                    <button
                        type="button"
                        className={mode === "practice" ? "g-seg-active" : undefined}
                        onClick={() => setMode("practice")}
                    >
                        练习
                    </button>
                    <button
                        type="button"
                        className={mode === "paper" ? "g-seg-active" : undefined}
                        onClick={() => setMode("paper")}
                    >
                        试卷
                    </button>
                </div>
            </div>

            {/* 生成中：执行步骤面板（管线阶段 + 步骤日志）+ 已落库进度 */}
            {generating && (
                <div className="mt-3 rounded-xl border border-[#d3e3fd] bg-[#f8fbff] px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#0b57d0]" />
                        <span className="text-[13px] font-medium text-[#1f1f1f]">
                            {quiz.generation_progress?.detail || "正在准备生成…"}
                        </span>
                        <span className="ml-auto shrink-0 text-[12px] text-[#444746]">
                            已落库 {total} / {genTotal} 题
                        </span>
                    </div>
                    {(quiz.generation_progress?.log?.length ?? 0) > 0 && (
                        <ol className="mt-2.5 space-y-1 border-t border-[#e8eaed] pt-2 text-[12px] text-[#444746]">
                            {[...(quiz.generation_progress?.log ?? [])]
                                .reverse()
                                .slice(0, 6)
                                .map((s, i) => (
                                    <li key={i} className="flex items-center gap-1.5">
                                        <span className="h-1 w-1 shrink-0 rounded-full bg-[#0b57d0]" />
                                        <span className="flex-1">{s.detail}</span>
                                        {s.at && <span className="shrink-0 text-[#747775]">{new Date(s.at).toLocaleTimeString()}</span>}
                                    </li>
                                ))}
                        </ol>
                    )}
                    <p className="mt-2 text-[11px] text-[#747775]">
                        新题会自动出现在下方；全部生成完成后即可交卷
                    </p>
                </div>
            )}

            {/* M3 线性进度（练习模式） */}
            {mode === "practice" && (
                <div className="g-progress mt-4">
                    <div style={{ width: progressPct + "%" }} />
                </div>
            )}

            {/* 题目区（practice）/ 整卷（paper） */}
            <div className="flex-1 overflow-y-auto py-6">
                {mode === "paper" && (
                    <QuizPaperTaking
                        quiz={quiz}
                        answers={answers}
                        onAnswer={(uuid, value) => setAnswers((prev) => ({ ...prev, [uuid]: value }))}
                    />
                )}

                {mode === "practice" && (
                    <motion.div
                        key={current}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className="g-card mx-auto max-w-[720px] px-6 py-6 md:px-8"
                    >
                        {/* 题型 chip + 题号 */}
                        <div className="flex items-center gap-2">
                            <span className="g-chip g-chip-static g-chip-selected">
                                {TYPE_LABEL[q.question_type] ?? q.question_type}
                            </span>
                            <span className="text-[12px] text-[#747775]">第 {current + 1} 题</span>
                        </div>

                        <div className="md-body mt-4 text-[16px] leading-relaxed text-[#1f1f1f]">
                            <Markdown>{q.question_text}</Markdown>
                        </div>

                        {/* 选择题选项（自适应：短选项桌面 2 列矩阵，长选项单列） */}
                        {isChoice && q.options && (
                            <div className={
                                "mt-5 grid grid-cols-1 gap-2 " +
                                (Math.max(...q.options.map((o) => optionParts(o, 0).text.length)) <= 10 ? "md:grid-cols-2" : "")
                            }>
                                {q.options.map((opt, i) => {
                                    const label = optionParts(opt, i).label;
                                    const active = isSingle ? myAnswer === label : activeMulti.includes(label);
                                    return (
                                        <button
                                            key={i}
                                            type="button"
                                            disabled={submitting}
                                            onClick={() =>
                                                isSingle
                                                    ? setSingle(q.question_uuid, label)
                                                    : toggleMulti(q.question_uuid, label)
                                            }
                                            className={cn("g-option", active && "g-option-selected")}
                                        >
                                            <span
                                                className={cn(
                                                    isMulti ? "g-check" : "g-radio",
                                                    active && (isMulti ? "g-check-selected" : "g-radio-selected"),
                                                )}
                                            >
                                                {isMulti && active && <Check className="h-3 w-3" />}
                                            </span>
                                            <span className="font-semibold text-[#0b57d0]">{label}</span>
                                            <span className="min-w-0 flex-1">
                                                <Markdown inline>{optionParts(opt, i).text}</Markdown>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* 主观题 */}
                        {!isChoice && (
                            <textarea
                                value={(typeof myAnswer === "string" ? myAnswer : "") ?? ""}
                                onChange={(e) => setText(q.question_uuid, e.target.value)}
                                disabled={submitting}
                                rows={5}
                                className="g-field mt-5 resize-none"
                                placeholder="输入你的答案…"
                            />
                        )}
                    </motion.div>
                )}
            </div>

            {/* Footer */}
            <div className="border-t border-[#c4c7c5] bg-transparent py-4">
                {error && (
                    <div className="g-banner mb-3">
                        <AlertCircle className="h-4 w-4 shrink-0 text-[#d93025]" />
                        {error}
                    </div>
                )}
                <div className="flex items-center justify-between gap-3">
                    {mode === "paper" ? (
                        <>
                            <span className="text-[12px] text-[#444746]">
                                {generating
                                    ? `生成中 ${total} / ${genTotal} 题`
                                    : `已答 ${answeredCount} / ${total} 题`}
                            </span>
                            <button
                                type="button"
                                onClick={submit}
                                disabled={submitting || generating}
                                title={generating ? "题目仍在生成，完成后可交卷" : undefined}
                                className="g-btn g-btn-filled !px-8"
                            >
                                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                                交卷
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                                disabled={current === 0}
                                className="g-btn g-btn-outlined"
                            >
                                <ChevronLeft className="h-4 w-4" />
                                上一题
                            </button>
                            {current < total - 1 ? (
                                <button
                                    type="button"
                                    onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
                                    className="g-btn g-btn-filled !px-8"
                                >
                                    下一题
                                    <ChevronRight className="h-4 w-4" />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={submit}
                                    disabled={submitting || generating}
                                    title={generating ? "题目仍在生成，完成后可交卷" : undefined}
                                    className="g-btn g-btn-filled !px-8"
                                >
                                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                                    提交批改
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
