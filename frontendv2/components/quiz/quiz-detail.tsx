"use client";

/**
 * QuizDetail - 单份题卷详情（动态路由 /quiz/[uuid]）。
 *
 * 内部状态机：loading → generating（4s 轮询，新题增量并入答题页）→
 * taking → result（提交后）。返回列表 = router.push("/quiz")；
 * URL 即状态：刷新/分享/前进后退均停留在当前题卷。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Loader2, AlertCircle, ChevronLeft } from "lucide-react";
import { quizApi, type QuizSetData, type QuizSubmissionResult } from "@/lib/api";
import { QuizTaking } from "./quiz-taking";
import { QuizResult } from "./quiz-result";
import { ExportPaperDialog } from "./export-paper-dialog";
import { QuizShareDialog } from "./share-dialog";

type DetailView = "loading" | "error" | "generating" | "taking" | "result";

export function QuizDetail({ quizUuid }: { quizUuid: string }) {
    const router = useRouter();
    const [view, setView] = useState<DetailView>("loading");
    const [activeQuiz, setActiveQuiz] = useState<QuizSetData | null>(null);
    const [submission, setSubmission] = useState<QuizSubmissionResult | null>(null);
    const [userAnswers, setUserAnswers] = useState<Record<string, string | string[]> | null>(null);
    const [quizError, setQuizError] = useState<string | null>(null);
    const [shareOpen, setShareOpen] = useState(false);
    const [exportQuiz, setExportQuiz] = useState<QuizSetData | null>(null);

    const backToList = useCallback(() => {
        router.push("/quiz");
    }, [router]);

    const explainEmpty = (quiz: QuizSetData): string => {
        if (quiz.status === "generating") return "题目仍在生成中，请稍后刷新";
        if (quiz.status === "failed")
            return quiz.error_message ? `该题卷生成失败：${quiz.error_message}` : "该题卷生成失败，请重新生成";
        return "该题卷暂无可练习的题目";
    };

    // 载入题卷（挂载 / 错误重试共用）
    const load = useCallback(async () => {
        setQuizError(null);
        setView("loading");
        try {
            const quiz = await quizApi.getQuiz(quizUuid);
            setActiveQuiz(quiz);
            setSubmission(null);
            setUserAnswers(null);
            // 生成中 → 实时进度视图（0 题也进入：能看到阶段/日志与已入库题目）
            if (quiz.status === "generating") {
                setView("generating");
                return;
            }
            if (!quiz.questions || quiz.questions.length === 0) {
                setQuizError(explainEmpty(quiz));
                setView("error");
                return;
            }
            setView("taking");
        } catch (e) {
            setQuizError(e instanceof Error ? e.message : "加载题目失败");
            setView("error");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quizUuid]);

    useEffect(() => {
        void load();
    }, [load]);

    // 生成中题卷：4s 轮询 getQuiz，新题增量并入答题页（作答状态按 question_uuid
    // 记账在 QuizTaking 本地，题卷对象更新不重置已答内容）；终态停止轮询。
    useEffect(() => {
        if (view !== "generating") return;
        if (!activeQuiz || activeQuiz.status !== "generating") return;
        let cancelled = false;
        const t = setInterval(async () => {
            try {
                const next = await quizApi.getQuiz(quizUuid);
                if (cancelled) return;
                if (next.status === "failed") {
                    setQuizError(next.error_message || "该题卷生成失败");
                    setView("error");
                    return;
                }
                if (next.status !== "generating") {
                    setActiveQuiz(next);
                    if (next.status === "done") setView("taking");
                    return;
                }
                if (next.questions.length !== activeQuiz.questions.length) {
                    setActiveQuiz(next);
                }
            } catch {
                // 瞬时轮询失败忽略，下一轮继续
            }
        }, 4000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [view, activeQuiz, quizUuid]);

    const handleSubmitted = useCallback(
        (result: QuizSubmissionResult, answers: Record<string, string | string[]>) => {
            setSubmission(result);
            setUserAnswers(answers);
            setView("result");
        },
        [],
    );

    const handleRetry = useCallback(() => {
        setSubmission(null);
        setUserAnswers(null);
        setView("taking");
    }, []);

    // 导出试卷：先取含答案的完整题卷，再开弹窗
    const openExport = useCallback(async () => {
        const q = await quizApi.getQuiz(quizUuid, true);
        setExportQuiz(q);
    }, [quizUuid]);

    return (
        <>
            {view === "loading" && !activeQuiz && !quizError && (
                <div className="flex flex-1 items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-[#0b57d0]" />
                </div>
            )}

            {view === "error" && (
                <div className="mx-auto w-full max-w-[820px] px-5 pt-6 md:px-8">
                    <div className="g-banner">
                        <AlertCircle className="h-4 w-4 shrink-0 text-[#0b57d0]" />
                        <span className="flex-1">{quizError}</span>
                        <button type="button" onClick={() => void load()} className="g-icon-btn !h-6 !w-6" aria-label="重试">
                            <Loader2 className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={backToList} className="g-icon-btn !h-6 !w-6" aria-label="返回列表">
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            )}

            {view === "generating" && activeQuiz && (
                <motion.div
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                    className="h-full overflow-y-auto"
                >
                    <div className="mx-auto max-w-[680px] px-6 pb-10 pt-6">
                        <div className="g-card px-5 py-5">
                            <div className="flex items-center gap-2.5">
                                <Loader2 className="h-5 w-5 animate-spin text-[#0b57d0]" />
                                <h2 className="text-[16px] font-medium text-[#1f1f1f]">题目生成进行中</h2>
                            </div>
                            <p className="mt-1.5 text-[13px] text-[#444746]">
                                {activeQuiz.generation_progress?.detail || "正在准备素材…"}（每 4 秒自动刷新）
                            </p>
                            {activeQuiz.generation_progress && activeQuiz.generation_progress.total > 0 && (
                                <div className="mt-4">
                                    <div className="flex items-baseline justify-between text-[12px] text-[#747775]">
                                        <span>已入库 {activeQuiz.generation_progress.stored} / {activeQuiz.generation_progress.total} 题</span>
                                        <span>{activeQuiz.generation_progress.stage}</span>
                                    </div>
                                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#e8eaed]">
                                        <div
                                            className="h-full rounded-full bg-[#0b57d0] transition-all duration-500"
                                            style={{
                                                width: Math.min(100, Math.round(
                                                    (activeQuiz.generation_progress.stored / activeQuiz.generation_progress.total) * 100,
                                                )) + "%",
                                            }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        {activeQuiz.questions.length > 0 && (
                            <div className="g-card mt-4 px-5 py-4">
                                <div className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                    已入库题目（可先做已生成的）
                                </div>
                                <div className="mt-2.5 space-y-2">
                                    {activeQuiz.questions.map((q, i) => (
                                        <div key={q.question_uuid} className="truncate text-[13px] text-[#1f1f1f]">
                                            {i + 1}. {q.question_text}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeQuiz.generation_progress?.log && activeQuiz.generation_progress.log.length > 0 && (
                            <div className="g-card mt-4 px-5 py-4">
                                <div className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">执行日志</div>
                                <div className="mt-2.5 space-y-1.5">
                                    {[...activeQuiz.generation_progress.log].reverse().map((e, i) => (
                                        <div key={e.at + i} className="text-[12px] text-[#444746]">
                                            <span className="mr-2 tabular-nums text-[#747775]">
                                                {new Date(e.at).toLocaleTimeString()}
                                            </span>
                                            [{e.stage}] {e.detail}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <button type="button" onClick={backToList} className="g-btn g-btn-text mt-4">
                            <ChevronLeft className="h-4 w-4" />
                            返回练习列表
                        </button>
                    </div>
                </motion.div>
            )}

            {view === "taking" && activeQuiz && (
                <QuizTaking
                    quiz={activeQuiz}
                    onBack={backToList}
                    onSubmitted={handleSubmitted}
                />
            )}

            {view === "result" && activeQuiz && submission && userAnswers && (
                <QuizResult
                    quiz={activeQuiz}
                    result={submission}
                    answers={userAnswers}
                    onBack={backToList}
                    onRetry={handleRetry}
                    onShare={() => setShareOpen(true)}
                    onExport={() => void openExport()}
                />
            )}

            {/* 测验分享弹窗（结果页触发） */}
            {shareOpen && (
                <QuizShareDialog
                    open
                    quizUuid={quizUuid}
                    onClose={() => setShareOpen(false)}
                />
            )}

            {/* 试卷导出弹窗（结果页触发） */}
            {exportQuiz && (
                <ExportPaperDialog open quiz={exportQuiz} onClose={() => setExportQuiz(null)} />
            )}
        </>
    );
}
