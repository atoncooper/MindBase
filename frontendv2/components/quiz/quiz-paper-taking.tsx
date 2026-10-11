"use client";

/**
 * QuizPaperTaking - 整卷试卷模式的作答视图（Google Material 3 视觉）。
 *
 * 与 lib/exam-paper.ts 的打印卷面同构：大题分节、题号 + 分值、A/B/C/D 选项
 * 排版，但选项/作答区是可交互的（点击作答、主观题文本域）。作答状态由父
 * 组件持有（与逐题练习模式共享同一 answers map 与提交流程）。
 */
import { groupPaperSections } from "@/lib/exam-paper";
import type { QuizSetData } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface QuizPaperTakingProps {
    quiz: QuizSetData;
    answers: Record<string, string | string[]>;
    onAnswer: (questionUuid: string, value: string | string[]) => void;
}

function optionParts(opt: string, index: number): { label: string; text: string } {
    const m = /^\s*([A-Za-z])(?:[.．、\s]+|$)/.exec(opt);
    const label = m ? m[1].toUpperCase() : String.fromCharCode("A".charCodeAt(0) + index);
    const text = m ? opt.replace(/^\s*[A-Za-z](?:[.．、\s]+)/, "").trim() : opt;
    return { label, text: text || opt };
}

const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function QuizPaperTaking({ quiz, answers, onAnswer }: QuizPaperTakingProps) {
    const sections = groupPaperSections(quiz);

    return (
        <div className="mx-auto w-full max-w-[860px] pb-4">
            {/* 注意事项（M3 卡片） */}
            <div className="g-card border-l-4 !border-l-[#0b57d0] px-5 py-4">
                <p className="text-[13px] font-semibold text-[#1f1f1f]">注意事项</p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#444746]">
                    共 {quiz.questions.length} 题，满分 {quiz.total_score > 0 ? quiz.total_score : 100}
                    分。选择题点击选项作答，简答/论述题在文本框内作答；完成后点击底部「交卷」统一批改。
                </p>
            </div>

            {sections.map((sec) => (
                <div key={sec.index} className="mt-8">
                    <p className="g-section-head">
                        {(CN[sec.index - 1] ?? String(sec.index))}、{sec.title}
                        <span className="text-[12px] font-normal text-[#444746]">
                            （共 {sec.questions.length} 小题，
                            {sec.uniform > 0 ? "每小题 " + sec.uniform + " 分，" : ""}合计 {sec.scoreSum} 分）
                        </span>
                    </p>

                    <div className="mt-3 space-y-6">
                        {sec.questions.map(({ number, q, score }) => {
                            const my = answers[q.question_uuid];
                            const isSingle = q.question_type === "single_choice";
                            const isMulti = q.question_type === "multi_choice";
                            const activeMulti = isMulti && Array.isArray(my) ? (my as string[]) : [];
                            return (
                                <div key={q.question_uuid} className="g-card px-4 py-4 md:px-5">
                                    <p className="text-[14px] leading-relaxed text-[#1f1f1f]">
                                        <span className="font-semibold text-[#0b57d0]">{number}.</span>
                                        <span className="text-[12px] text-[#747775]">（{score} 分</span>
                                        {q.question_type === "multi_choice" && !/多选/.test(q.question_text) && (
                                            <span className="text-[12px] text-[#747775]">，多选</span>
                                        )}
                                        <span className="text-[12px] text-[#747775]">）</span>
                                        <span className="md-body ml-1 inline">
                                            <Markdown>{q.question_text}</Markdown>
                                        </span>
                                    </p>

                                    {(isSingle || isMulti) && q.options && (
                                        <div className="mt-3 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                                            {q.options.map((opt, i) => {
                                                const { label, text } = optionParts(opt, i);
                                                const active = isSingle ? my === label : activeMulti.includes(label);
                                                return (
                                                    <button
                                                        key={i}
                                                        type="button"
                                                        onClick={() => {
                                                            if (isSingle) onAnswer(q.question_uuid, label);
                                                            else {
                                                                const next = active
                                                                    ? activeMulti.filter((x) => x !== label)
                                                                    : [...activeMulti, label];
                                                                onAnswer(q.question_uuid, next);
                                                            }
                                                        }}
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
                                                            <Markdown inline>{text}</Markdown>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {!isSingle && !isMulti && (
                                        <textarea
                                            value={(typeof my === "string" ? my : "") ?? ""}
                                            onChange={(e) => onAnswer(q.question_uuid, e.target.value)}
                                            rows={q.question_type === "essay" ? 5 : 3}
                                            className="g-field mt-3 resize-y"
                                            placeholder={q.question_type === "essay" ? "按要点作答…" : "简答…"}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}
