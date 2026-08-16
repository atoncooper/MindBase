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
import { Loader2, AlertCircle, X } from "lucide-react";
import {
    quizApi,
    type QuizSetData,
    type QuizSubmissionResult,
} from "@/lib/api";
import { QuizList } from "./quiz-list";
import { QuizTaking } from "./quiz-taking";
import { QuizResult } from "./quiz-result";
import { GenerateDialog } from "./generate-dialog";

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

    const handleGenerated = useCallback((quiz: QuizSetData) => {
        if (!quiz.questions || quiz.questions.length === 0) {
            setQuizError(explainEmpty(quiz));
            setDialogOpen(false);
            setListRefreshKey((k) => k + 1);
            return;
        }
        setActiveQuiz(quiz);
        setSubmission(null);
        setUserAnswers(null);
        setDialogOpen(false);
        setListRefreshKey((k) => k + 1);
        setView("taking");
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

    // Deep link: /quiz?quiz=<uuid> auto-opens that quiz once (e.g. the
    // chat page's quiz-from-summary dialog "去答题" button). Read from
    // window.location so no Suspense boundary is required around this page.
    const deepLinkedRef = useRef(false);
    useEffect(() => {
        if (deepLinkedRef.current) return;
        const param = new URLSearchParams(window.location.search).get("quiz");
        if (!param) return;
        deepLinkedRef.current = true;
        // handleSelect identity is stable (no deps); call after mount.
        void handleSelect(param);
    }, [handleSelect]);

    return (
        <>
            {view === "list" && (
                <>
                    {quizError && (
                        <div className="mx-auto max-w-[760px] px-5 pt-5 md:px-8">
                            <div className="flex items-center gap-2 rounded-xl border-l-2 border-foreground bg-surface px-4 py-3 text-[13px] text-foreground">
                                <AlertCircle className="h-4 w-4 shrink-0" />
                                <span className="flex-1">{quizError}</span>
                                <button
                                    type="button"
                                    onClick={() => setQuizError(null)}
                                    className="grid h-5 w-5 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
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
                        refreshKey={listRefreshKey}
                    />
                    <GenerateDialog
                        open={dialogOpen}
                        onClose={() => setDialogOpen(false)}
                        onGenerated={handleGenerated}
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
                />
            )}

            {/* Loading overlay when fetching a selected quiz */}
            {loadingQuiz && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center bg-background/60">
                    <Loader2 className="h-7 w-7 animate-spin text-foreground" />
                </div>
            )}
        </>
    );
}
