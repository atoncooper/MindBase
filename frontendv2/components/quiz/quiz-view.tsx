"use client";

/**
 * QuizView - orchestrator for the 题目练习 page.
 *
 * Owns the list <-> taking <-> result state machine. The list view shows
 * history and the new-practice dialog; selecting/creating a quiz loads its
 * questions and enters taking; submit hands off to result. Retry returns to
 * taking with the same quiz (a new submission is created on next submit).
 *
 * A quiz with no questions (failed / still generating / data lost) never
 * enters taking - a banner on the list explains why.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, X, Check } from "lucide-react";
import {
    quizApi,
    type QuizSetData,
    type QuizSubmissionResult,
} from "@/lib/api";
import { QuizList } from "./quiz-list";
import { QuizTaking } from "./quiz-taking";
import { QuizResult } from "./quiz-result";
import { GenerateDialog } from "./generate-dialog";
import { QuizShareDialog } from "./share-dialog";
import { ExportPaperDialog } from "./export-paper-dialog";

type View = "list" | "taking" | "result";

export function QuizView() {
    const [view, setView] = useState<View>("list");
    const [activeQuiz, setActiveQuiz] = useState<QuizSetData | null>(null);
    const [submission, setSubmission] = useState<QuizSubmissionResult | null>(null);
    const [userAnswers, setUserAnswers] = useState<
        Record<string, string | string[]> | null
    >(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [listRefreshKey, setListRefreshKey] = useState(0);
    const [loadingQuiz, setLoadingQuiz] = useState(false);
    const [quizError, setQuizError] = useState<string | null>(null);
    // 后台生成已提交的轻提示（列表顶部，可关闭）
    const [notice, setNotice] = useState<string | null>(null);
    // 分享弹窗：非空 = 打开并针对该题卷
    const [shareQuizUuid, setShareQuizUuid] = useState<string | null>(null);
    // 试卷导出弹窗：非空 = 已加载完整题卷数据（含答案，供导出选项使用）
    const [exportQuiz, setExportQuiz] = useState<QuizSetData | null>(null);
    const [exportLoading, setExportLoading] = useState(false);

    const enterList = useCallback(() => {
        setView("list");
        setListRefreshKey((k) => k + 1);
    }, []);

    const explainEmpty = (quiz: QuizSetData): string => {
        if (quiz.status === "generating") return "题目仍在生成中，请稍后刷新列表";
        if (quiz.status === "failed")
            return quiz.error_message
                ? `该题卷生成失败：${quiz.error_message}`
                : "该题卷生成失败，请重新生成";
        return "该题卷暂无可练习的题目";
    };

    const handleSelect = useCallback(async (quizUuid: string) => {
        setLoadingQuiz(true);
        setQuizError(null);
        try {
            const quiz = await quizApi.getQuiz(quizUuid);
            if (!quiz.questions || quiz.questions.length === 0) {
                setQuizError(explainEmpty(quiz));
                return;
            }
            setActiveQuiz(quiz);
            setSubmission(null);
            setUserAnswers(null);
            setView("taking");
        } catch (e) {
            setQuizError(e instanceof Error ? e.message : "加载题目失败");
        } finally {
            setLoadingQuiz(false);
        }
    }, []);

    // 对话框提交成功：后端已创建 generating 题集并转入后台生成，关闭对话框 +
    // 刷新列表 + 轻提示（auto 模式附 AI 配卷说明）。生成中项可点开边生成边作答。
    const handleGenerationStarted = useCallback((quizUuid: string, specReason?: string) => {
        setDialogOpen(false);
        setListRefreshKey((k) => k + 1);
        setNotice(
            "已提交后台生成（" + quizUuid.slice(0, 8) + "…）" +
                (specReason ? "：" + specReason : "") +
                "；生成中的题卷可点开，已出的题能先做",
        );
    }, []);

    const handleSubmitted = useCallback(
        (
            result: QuizSubmissionResult,
            answers: Record<string, string | string[]>,
        ) => {
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

    // 导出试卷：先取含答案的完整题卷（预览与参考答案页需要），再开弹窗
    const openExport = useCallback(async (quizUuid: string) => {
        setExportLoading(true);
        try {
            const q = await quizApi.getQuiz(quizUuid, true);
            setExportQuiz(q);
        } catch {
            // 静默失败不阻塞主流程；弹窗内导出会再次给出明确错误
        } finally {
            setExportLoading(false);
        }
    }, []);

    // Deep link: /quiz?quiz=<uuid> auto-opens that quiz once (e.g. the
    // chat page's quiz-from-summary dialog "去答题" button). Read from
    // window.location so no Suspense boundary is required around this page.
    const deepLinkedRef = useRef(false);
    useEffect(() => {
        if (deepLinkedRef.current) return;
        const param = new URLSearchParams(window.location.search).get("quiz");
        if (!param) return;
        deepLinkedRef.current = true;
        // handleSelect identity is stable (no deps); defer past the effect body
        // (react-hooks/set-state-in-effect: the fetch sets state synchronously).
        const t = setTimeout(() => void handleSelect(param), 0);
        return () => clearTimeout(t);
    }, [handleSelect]);

    // 生成中题卷：4s 轮询 getQuiz，新题增量并入答题页（作答状态按 question_uuid
    // 记账在 QuizTaking 本地，题卷对象更新不重置已答内容）；终态停止轮询。
    useEffect(() => {
        if (view !== "taking" || !activeQuiz || activeQuiz.status !== "generating") return;
        let cancelled = false;
        const quizUuid = activeQuiz.quiz_uuid;
        const t = setInterval(async () => {
            try {
                const next = await quizApi.getQuiz(quizUuid);
                if (cancelled) return;
                if (next.status === "failed") {
                    setActiveQuiz(null);
                    setQuizError(next.error_message || "该题卷生成失败");
                    setView("list");
                    return;
                }
                if (next.status !== "generating" || next.questions.length !== activeQuiz.questions.length) {
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
    }, [view, activeQuiz]);

    return (
        <>
            {view === "list" && (
                <>
                    {notice && (
                        <div className="mx-auto max-w-[820px] px-5 pt-5 md:px-8">
                            <div className="g-banner">
                                <Check className="h-4 w-4 shrink-0 text-[#188038]" />
                                <span className="flex-1">{notice}</span>
                                <button
                                    type="button"
                                    onClick={() => setNotice(null)}
                                    className="g-icon-btn !h-6 !w-6"
                                    aria-label="关闭提示"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                    {quizError && (
                        <div className="mx-auto max-w-[820px] px-5 pt-5 md:px-8">
                            <div className="g-banner">
                                <AlertCircle className="h-4 w-4 shrink-0 text-[#0b57d0]" />
                                <span className="flex-1">{quizError}</span>
                                <button
                                    type="button"
                                    onClick={() => setQuizError(null)}
                                    className="g-icon-btn !h-6 !w-6"
                                    aria-label="关闭提示"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                    <QuizList
                        onNew={() => {
                            setQuizError(null);
                            setDialogOpen(true);
                        }}
                        onSelect={handleSelect}
                        onShare={(quizUuid) => setShareQuizUuid(quizUuid)}
                        onExport={openExport}
                        refreshKey={listRefreshKey}
                    />
                    <GenerateDialog
                        open={dialogOpen}
                        onClose={() => setDialogOpen(false)}
                        onSubmitted={handleGenerationStarted}
                    />
                </>
            )}

            {view === "taking" && activeQuiz && (
                <QuizTaking
                    quiz={activeQuiz}
                    onBack={enterList}
                    onSubmitted={handleSubmitted}
                />
            )}

            {view === "result" && activeQuiz && submission && userAnswers && (
                <QuizResult
                    quiz={activeQuiz}
                    result={submission}
                    answers={userAnswers}
                    onBack={enterList}
                    onRetry={handleRetry}
                    onShare={() => setShareQuizUuid(activeQuiz.quiz_uuid)}
                    onExport={() => void openExport(activeQuiz.quiz_uuid)}
                />
            )}

            {/* Loading overlay when fetching a selected quiz */}
            {loadingQuiz && (
                <div className="g-overlay fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(32,33,36,0.5)]">
                    <Loader2 className="h-7 w-7 animate-spin text-white" />
                </div>
            )}

            {/* 测验分享弹窗（结果页与列表行均可触发） */}
            {shareQuizUuid && (
                <QuizShareDialog
                    open
                    quizUuid={shareQuizUuid}
                    onChanged={() => setListRefreshKey((k) => k + 1)}
                    onClose={() => setShareQuizUuid(null)}
                />
            )}

            {/* 试卷导出弹窗（列表行 / 答题页 / 结果页均可触发） */}
            {exportQuiz && (
                <ExportPaperDialog open quiz={exportQuiz} onClose={() => setExportQuiz(null)} />
            )}
            {exportLoading && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(32,33,36,0.5)]">
                    <Loader2 className="h-7 w-7 animate-spin text-white" />
                </div>
            )}
        </>
    );
}
