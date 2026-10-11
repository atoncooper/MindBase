"use client";

/**
 * ExportPaperDialog - 导出/打印试卷弹窗（Google Material 3 视觉）。
 *
 * 左侧 A4 卷面实时预览（iframe srcDoc，与打印输出同源同一份 HTML），
 * 右侧为 M3 单选列表（卷面风格）+ 复选项（含参考答案页）+ 按钮组
 * （filled 主操作 / outlined 次操作）。
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, FileDown, Printer, FileCode2, AlertCircle, Check } from "lucide-react";
import { quizApi, type QuizSetData } from "@/lib/api";
import { buildExamPaperHtml, printExamPaper, downloadExamPaperHtml, type PaperStyle } from "@/lib/exam-paper";
import { cn } from "@/lib/utils";

interface ExportPaperDialogProps {
    open: boolean;
    quiz: QuizSetData;
    onClose: () => void;
}

const STYLE_OPTIONS: Array<{ v: PaperStyle; label: string; desc: string }> = [
    { v: "standard", label: "标准练习", desc: "通用卷面，适合日常练习打印" },
    { v: "gaokao", label: "高考风格", desc: "绝密★启用前卷头 + 高考注意事项" },
    { v: "kaoyan", label: "考研风格", desc: "全国硕士研究生招生考试卷头" },
];

export function ExportPaperDialog({ open, quiz, onClose }: ExportPaperDialogProps) {
    const [style, setStyle] = useState<PaperStyle>("standard");
    const [includeAnswers, setIncludeAnswers] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const html = useMemo(
        () => (open ? buildExamPaperHtml(quiz, { style, includeAnswers }) : ""),
        [open, quiz, style, includeAnswers],
    );

    if (typeof window === "undefined") return null;

    async function handleDocx() {
        setExporting(true);
        setError(null);
        try {
            const blob = await quizApi.exportPaper(quiz.quiz_uuid, { style, with_answers: includeAnswers });
            quizApi.downloadBlob(blob, (quiz.title || "试卷") + ".docx");
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "试卷导出失败");
        } finally {
            setExporting(false);
        }
    }

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="quiz-scope g-overlay fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(32,33,36,0.5)] p-4 md:p-8"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.97, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 10 }}
                        transition={{ duration: 0.18, ease: [0.28, 0.11, 0.32, 1] }}
                        className="g-dialog flex h-full max-h-[880px] w-full max-w-[1180px] flex-col overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <header className="flex items-center justify-between border-b border-[#c4c7c5] px-6 py-4">
                            <div className="min-w-0">
                                <h2 className="text-[18px] font-medium tracking-normal text-[#1f1f1f]">导出试卷</h2>
                                <p className="mt-0.5 truncate text-[12px] text-[#444746]">{quiz.title || "未命名题卷"}</p>
                            </div>
                            <button type="button" onClick={onClose} className="g-icon-btn" aria-label="关闭">
                                <X className="h-[18px] w-[18px]" />
                            </button>
                        </header>

                        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                            {/* 选项侧栏 */}
                            <aside className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-b border-[#c4c7c5] px-6 py-5 md:w-[320px] md:border-b-0 md:border-r">
                                <div>
                                    <p className="text-[13px] font-semibold text-[#1f1f1f]">卷面风格</p>
                                    <div className="mt-2.5 space-y-1">
                                        {STYLE_OPTIONS.map((s) => {
                                            const active = style === s.v;
                                            return (
                                                <button
                                                    key={s.v}
                                                    type="button"
                                                    onClick={() => setStyle(s.v)}
                                                    className={cn(
                                                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                                                        active ? "bg-[#d3e3fd]" : "hover:bg-[rgba(31,31,31,0.04)]",
                                                    )}
                                                >
                                                    <span
                                                        className={cn(
                                                            "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2",
                                                            active ? "border-[#0b57d0]" : "border-[#747775]",
                                                        )}
                                                    >
                                                        {active && <span className="h-2 w-2 rounded-full bg-[#0b57d0]" />}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="block text-[14px] font-medium text-[#1f1f1f]">{s.label}</span>
                                                        <span className="block text-[11px] leading-snug text-[#444746]">{s.desc}</span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div>
                                    <p className="text-[13px] font-semibold text-[#1f1f1f]">内容</p>
                                    <button
                                        type="button"
                                        onClick={() => setIncludeAnswers((v) => !v)}
                                        className="mt-2.5 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[rgba(31,31,31,0.04)]"
                                    >
                                        <span
                                            className={cn(
                                                "g-check",
                                                includeAnswers && "g-check-selected",
                                            )}
                                        >
                                            {includeAnswers && <Check className="h-3 w-3" />}
                                        </span>
                                        <span className="text-[14px] text-[#1f1f1f]">含参考答案与解析页（另起一页）</span>
                                    </button>
                                </div>

                                {/* 操作区 */}
                                <div className="mt-auto space-y-2">
                                    <button
                                        type="button"
                                        disabled={exporting}
                                        onClick={handleDocx}
                                        className="g-btn g-btn-filled w-full"
                                    >
                                        {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-[18px] w-[18px]" />}
                                        下载 Word 试卷（.docx）
                                    </button>
                                    <button type="button" onClick={() => printExamPaper(html)} className="g-btn g-btn-outlined w-full">
                                        <Printer className="h-[18px] w-[18px]" />
                                        打印 / 保存 PDF
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => downloadExamPaperHtml(quiz, { style, includeAnswers })}
                                        className="g-btn g-btn-outlined w-full"
                                    >
                                        <FileCode2 className="h-[18px] w-[18px]" />
                                        下载网页版（.html）
                                    </button>
                                    {error && (
                                        <div className="flex items-start gap-2 rounded-lg bg-[#fce8e6] px-3 py-2 text-[12px] text-[#d93025]">
                                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            {error}
                                        </div>
                                    )}
                                </div>
                            </aside>

                            {/* 预览 */}
                            <div className="min-h-0 flex-1 bg-[#e9eef6] p-4">
                                <iframe
                                    title="试卷预览"
                                    srcDoc={html}
                                    className="h-full w-full rounded-xl border border-[#c4c7c5] bg-white"
                                />
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}
