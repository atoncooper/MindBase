"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle, XCircle, Download, Database, Layers, History, Eye, ArrowLeft, ArrowRight, Trash2, Share2, Copy, Link as LinkIcon, CircleAlert } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    quizApi,
    favoritesV2Api,
    knowledgeApi,
    type QuizSetData,
    type QuizQuestion,
    type QuizAnswerResult,
    type QuizSubmissionResult,
    type FavoriteFolder,
    type FolderStatus,
    type VectorizedPageItem,
    type QuizHistoryItem,
    type QuizShareStatus,
} from "@/lib/api";
import { type DockPanelProps } from "@/lib/dock-registry";
import { useDockContext } from "@/lib/dock-context";

const TYPE_LABELS: Record<string, string> = {
    single_choice: "单选",
    multi_choice: "多选",
    short_answer: "简答",
    essay: "主观",
};

const DIFFICULTY_LABELS: Record<string, string> = {
    easy: "简单",
    medium: "中等",
    hard: "困难",
};

interface FolderInfo {
    media_id: number;
    title: string;
    media_count: number;
    indexed_count: number;
}

export default function QuizPanel({ isOpen }: DockPanelProps) {
    const { sessionId } = useDockContext();

    const [mode, setMode] = useState<"folder" | "pages">("folder");
    const [quizSerial] = useState(() => String(Math.floor(1000 + Math.random() * 9000)));

    const [folders, setFolders] = useState<FolderInfo[]>([]);
    const [loadingFolders, setLoadingFolders] = useState(false);
    const [selectedFolderIds, setSelectedFolderIds] = useState<Set<number>>(new Set());

    const [vectorizedPages, setVectorizedPages] = useState<VectorizedPageItem[]>([]);
    const [loadingPages, setLoadingPages] = useState(false);
    const [selectedPageKeys, setSelectedPageKeys] = useState<Set<string>>(new Set());

    const [questionCount, setQuestionCount] = useState(10);
    const [difficulty, setDifficulty] = useState("medium");
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [currentQuiz, setCurrentQuiz] = useState<QuizSetData | null>(null);
    const [userAnswers, setUserAnswers] = useState<Map<string, string | string[]>>(new Map());
    const [submitting, setSubmitting] = useState(false);
    const [submitResult, setSubmitResult] = useState<QuizSubmissionResult | null>(null);

    const [isReviewMode, setIsReviewMode] = useState(false);
    const [reviewCorrectAnswers, setReviewCorrectAnswers] = useState<Map<string, string | string[]>>(new Map());

    const [showHistory, setShowHistory] = useState(false);
    const [historyItems, setHistoryItems] = useState<QuizHistoryItem[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [deletingQuizUuid, setDeletingQuizUuid] = useState<string | null>(null);

    // Share modal state
    const [shareModalUuid, setShareModalUuid] = useState<string | null>(null);
    const [shareStatus, setShareStatus] = useState<QuizShareStatus | null>(null);
    const [shareLoading, setShareLoading] = useState(false);
    const [shareError, setShareError] = useState<string | null>(null);
    const [shareDuration, setShareDuration] = useState<number | "">("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!isOpen || !sessionId) return;
        setLoadingFolders(true);
        Promise.all([
            favoritesV2Api.listFolders(),
            knowledgeApi.getFolderStatus(),
        ])
            .then(([favList, statusList]) => {
                const statusMap = new Map<number, FolderStatus>();
                for (const s of statusList) statusMap.set(s.media_id, s);

                const merged: FolderInfo[] = favList.map((f: FavoriteFolder) => ({
                    media_id: f.media_id,
                    title: f.title,
                    media_count: f.media_count,
                    indexed_count: statusMap.get(f.media_id)?.indexed_count ?? 0,
                }));
                setFolders(merged);

                const preSelected = new Set<number>();
                for (const f of merged) {
                    if (f.indexed_count > 0) preSelected.add(f.media_id);
                }
                setSelectedFolderIds(preSelected);
            })
            .catch(() => setError("获取收藏夹列表失败"))
            .finally(() => setLoadingFolders(false));
    }, [isOpen, sessionId]);

    useEffect(() => {
        if (!isOpen) {
            setCurrentQuiz(null);
            setSubmitResult(null);
            setUserAnswers(new Map());
            setError(null);
            setVectorizedPages([]);
            setSelectedPageKeys(new Set());
            setIsReviewMode(false);
            setReviewCorrectAnswers(new Map());
            setShowHistory(false);
        }
    }, [isOpen]);

    const toggleFolder = useCallback((id: number) => {
        setSelectedFolderIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }, []);

    const fetchVectorizedPages = useCallback(async () => {
        setLoadingPages(true);
        setError(null);
        try {
            const pages = await knowledgeApi.getVectorizedPages();
            setVectorizedPages(pages);
            const keys = new Set<string>();
            for (const p of pages) {
                keys.add(`${p.bvid}:${p.page_index}`);
            }
            setSelectedPageKeys(keys);
        } catch (e) {
            setError(e instanceof Error ? e.message : "获取分P列表失败");
        } finally {
            setLoadingPages(false);
        }
    }, []);

    useEffect(() => {
        if (mode === "pages" && isOpen) {
            fetchVectorizedPages();
        }
    }, [mode, isOpen, fetchVectorizedPages]);

    const togglePage = useCallback((bvid: string, pageIndex: number) => {
        setSelectedPageKeys((prev) => {
            const next = new Set(prev);
            const key = `${bvid}:${pageIndex}`;
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    }, []);

    const toggleAllPages = useCallback(() => {
        if (vectorizedPages.length === 0) return;
        const allKeys = vectorizedPages.map((p) => `${p.bvid}:${p.page_index}`);
        const allSelected = allKeys.every((k) => selectedPageKeys.has(k));
        setSelectedPageKeys(new Set(allSelected ? [] : allKeys));
    }, [vectorizedPages, selectedPageKeys]);

    const handleGenerate = useCallback(async () => {
        if (!sessionId) {
            setError("未登录");
            return;
        }

        setGenerating(true);
        setError(null);
        setCurrentQuiz(null);
        setSubmitResult(null);
        setUserAnswers(new Map());
        setIsReviewMode(false);

        try {
            if (mode === "pages") {
                const pages = vectorizedPages
                    .filter((p) => selectedPageKeys.has(`${p.bvid}:${p.page_index}`))
                    .map((p) => ({
                        bvid: p.bvid,
                        cid: p.cid,
                        page_index: p.page_index,
                        page_title: p.page_title || p.video_title || "",
                    }));

                if (pages.length === 0) {
                    setError("请选择至少一个分P");
                    setGenerating(false);
                    return;
                }

                const res = await quizApi.generate({
                    pages,
                    question_count: questionCount,
                    difficulty,
                });
                const quiz = await pollUntilReady(res.quiz_uuid);
                setCurrentQuiz(quiz);
            } else {
                const fids = Array.from(selectedFolderIds);
                if (fids.length === 0) {
                    setError("请选择至少一个收藏夹");
                    setGenerating(false);
                    return;
                }

                const res = await quizApi.generate({
                    folder_ids: fids,
                    question_count: questionCount,
                    difficulty,
                });
                const quiz = await pollUntilReady(res.quiz_uuid);
                setCurrentQuiz(quiz);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成失败");
        } finally {
            setGenerating(false);
        }
    }, [mode, selectedFolderIds, selectedPageKeys, vectorizedPages, questionCount, difficulty, sessionId]);

    const handleSubmit = useCallback(async () => {
        if (!currentQuiz || !sessionId) return;

        const answers = currentQuiz.questions
            .map((q) => ({
                question_uuid: q.question_uuid,
                answer: userAnswers.get(q.question_uuid) ?? "",
            }))
            .filter((a) => a.answer !== "");

        setSubmitting(true);
        try {
            const result = await quizApi.submit({
                quiz_uuid: currentQuiz.quiz_uuid,
                answers,
            });
            setSubmitResult(result);
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        } finally {
            setSubmitting(false);
        }
    }, [currentQuiz, sessionId, userAnswers]);

    const handleExport = useCallback(
        async (format: "jsonl" | "csv" | "sft") => {
            if (!sessionId) return;
            try {
                const blob = await quizApi.exportData(format);
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `quiz_export.${format}`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (e) {
                setError(e instanceof Error ? e.message : "导出失败");
            }
        },
        [sessionId]
    );

    const handleDownloadQuiz = useCallback(async (quizUuid: string, title: string) => {
        try {
            const quiz = await quizApi.getQuiz(quizUuid, true);
            const blob = new Blob([JSON.stringify(quiz, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${title || "quiz"}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : "下载失败");
        }
    }, []);

    const fetchHistory = useCallback(async () => {
        if (!sessionId) return;
        setLoadingHistory(true);
        try {
            const res = await quizApi.getHistory(1, 50);
            setHistoryItems(res.submissions);
        } catch (e) {
            setError(e instanceof Error ? e.message : "获取历史失败");
        } finally {
            setLoadingHistory(false);
        }
    }, [sessionId]);

    const handleViewPastQuiz = useCallback(async (quizUuid: string) => {
        try {
            const quiz = await quizApi.getQuiz(quizUuid, true);
            if (quiz.status === "failed") {
                setError(quiz.error_message || "题目生成失败");
                return;
            }
            const answers = new Map<string, string | string[]>();
            for (const q of quiz.questions) {
                if (q.correct_answer !== undefined) {
                    answers.set(q.question_uuid, q.correct_answer);
                }
            }
            setReviewCorrectAnswers(answers);
            setCurrentQuiz(quiz);
            setIsReviewMode(true);
            setSubmitResult(null);
            setUserAnswers(new Map());
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载题目失败");
        }
    }, []);

    const handleRetakeQuiz = useCallback(async (quizUuid: string) => {
        try {
            const quiz = await quizApi.getQuiz(quizUuid, false);
            if (quiz.status === "failed") {
                setError(quiz.error_message || "题目生成失败，无法重做");
                return;
            }
            setReviewCorrectAnswers(new Map());
            setCurrentQuiz(quiz);
            setIsReviewMode(false);
            setSubmitResult(null);
            setUserAnswers(new Map());
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载题目失败");
        }
    }, []);

    const handleDeleteQuiz = useCallback(async (item: QuizHistoryItem) => {
        const confirmed = window.confirm(
            `确定要永久删除「${item.title}」吗？\n\n` +
            "此操作不可撤销，将删除该题目集、所有作答记录、错题记录和题目数据。\n" +
            "删除后无法恢复。"
        );

        if (!confirmed) return;

        setDeletingQuizUuid(item.quiz_uuid);
        setError(null);

        try {
            await quizApi.deleteQuiz(item.quiz_uuid);
            setHistoryItems((prev) => prev.filter((x) => x.quiz_uuid !== item.quiz_uuid));

            if (currentQuiz?.quiz_uuid === item.quiz_uuid) {
                setCurrentQuiz(null);
                setSubmitResult(null);
                setUserAnswers(new Map());
                setIsReviewMode(false);
                setReviewCorrectAnswers(new Map());
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除失败");
        } finally {
            setDeletingQuizUuid(null);
        }
    }, [currentQuiz]);

    const handleBackToGenerate = useCallback(() => {
        setCurrentQuiz(null);
        setIsReviewMode(false);
        setSubmitResult(null);
        setUserAnswers(new Map());
        setReviewCorrectAnswers(new Map());
    }, []);

    const shareUrl = useCallback(
        (token: string) => {
            if (typeof window === "undefined") return `/quiz/share-view/${token}`;
            return `${window.location.origin}/quiz/share-view/${token}`;
        },
        [],
    );

    const handleOpenShare = useCallback(async (quizUuid: string) => {
        setShareModalUuid(quizUuid);
        setShareStatus(null);
        setShareError(null);
        setShareDuration("");
        setCopied(false);
        setShareLoading(true);
        try {
            const status = await quizApi.getShareStatus(quizUuid);
            setShareStatus(status);
        } catch (e) {
            setShareError(e instanceof Error ? e.message : "获取分享状态失败");
        } finally {
            setShareLoading(false);
        }
    }, []);

    const handleCloseShare = useCallback(() => {
        setShareModalUuid(null);
        setShareStatus(null);
        setShareError(null);
        setShareDuration("");
        setCopied(false);
    }, []);

    const handleCreateShare = useCallback(async () => {
        if (!shareModalUuid) return;
        const days =
            shareDuration === "" ? null : Number(shareDuration);
        if (days !== null && (!Number.isFinite(days) || days < 1 || days > 365)) {
            setShareError("有效期必须在 1~365 天之间");
            return;
        }
        setShareLoading(true);
        setShareError(null);
        try {
            const res = await quizApi.createShare(shareModalUuid, days);
            const status: QuizShareStatus = {
                quiz_uuid: res.quiz_uuid,
                shared: true,
                share_token: res.share_token,
                shared_at: res.shared_at,
                share_expires_at: res.share_expires_at,
                expired: false,
            };
            setShareStatus(status);
            setCopied(false);
        } catch (e) {
            setShareError(e instanceof Error ? e.message : "创建分享失败");
        } finally {
            setShareLoading(false);
        }
    }, [shareModalUuid, shareDuration]);

    const handleRevokeShare = useCallback(async () => {
        if (!shareModalUuid) return;
        if (!window.confirm("确定撤销分享？撤销后已分享的链接立即失效。")) return;
        setShareLoading(true);
        setShareError(null);
        try {
            await quizApi.revokeShare(shareModalUuid);
            setShareStatus({ quiz_uuid: shareModalUuid, shared: false });
            setCopied(false);
        } catch (e) {
            setShareError(e instanceof Error ? e.message : "撤销失败");
        } finally {
            setShareLoading(false);
        }
    }, [shareModalUuid]);

    const handleCopyShareLink = useCallback(async () => {
        if (!shareStatus?.share_token) return;
        const url = shareUrl(shareStatus.share_token);
        try {
            if (!navigator.clipboard?.writeText) {
                throw new Error("clipboard API unavailable");
            }
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Don't fall back to deprecated document.execCommand("copy") —
            // surface a clear hint so the user can copy manually from the
            // readonly input rendered in the share ticket.
            setShareError("复制失败，请手动选中链接后 Ctrl+C 复制");
        }
    }, [shareStatus, shareUrl]);

    const isAllAnswered =
        currentQuiz?.questions.every((q) => {
            const ans = userAnswers.get(q.question_uuid);
            if (!ans) return false;
            if (Array.isArray(ans)) return ans.length > 0;
            return String(ans).trim().length > 0;
        }) ?? false;

    if (!isOpen) return null;

    const selectedFolderCount = selectedFolderIds.size;
    const hasIndexedFolders = folders.some((f) => f.indexed_count > 0);

    const totalPageCount = vectorizedPages.length;
    const selectedPageCount = selectedPageKeys.size;
    const allPagesSelected = totalPageCount > 0 && selectedPageCount === totalPageCount;

    return (
        <div className="quiz" style={{ color: "var(--foreground)", padding: "16px", overflow: "auto", flex: 1 }}>
            {error && (
                <div className="quiz-error">
                    <span>{error}</span>
                    <button className="quiz-error__close" onClick={() => setError(null)} aria-label="关闭">
                        ✕
                    </button>
                </div>
            )}

            {!currentQuiz ? (
                <div className="quiz-paper">
                    <header className="quiz-paper__head">
                        <div className="quiz-paper__meta-strip">
                            <span className="quiz-paper__serial">№ {quizSerial}</span>
                            <span className="quiz-paper__rule" />
                            <span className="quiz-paper__kicker">QUIZ · COMPOSE</span>
                        </div>
                        <h3 className="quiz-paper__title">出题</h3>
                        <p className="quiz-paper__sub">
                            选取知识库范围，AI 拟一套练习卷
                        </p>
                    </header>

                    <section className="quiz-block">
                        <div className="quiz-block__label">
                            <span className="quiz-block__num">I</span>
                            <span className="quiz-block__en">SCOPE</span>
                            <span className="quiz-block__cn">范围</span>
                            <span className="quiz-block__count">
                                {mode === "folder"
                                    ? `${selectedFolderCount} 项`
                                    : `${selectedPageCount}/${totalPageCount} P`}
                            </span>
                        </div>

                        <div className="quiz-tabs" data-mode={mode}>
                            <button
                                className="quiz-tabs__btn"
                                data-active={mode === "folder"}
                                onClick={() => setMode("folder")}
                            >
                                按收藏夹
                            </button>
                            <button
                                className="quiz-tabs__btn"
                                data-active={mode === "pages"}
                                onClick={() => setMode("pages")}
                            >
                                按分P
                            </button>
                        </div>

                        {mode === "folder" && (
                            <>
                                {loadingFolders ? (
                                    <div className="quiz-loading">
                                        <Loader2 size={16} className="animate-spin" />
                                        加载收藏夹...
                                    </div>
                                ) : folders.length === 0 ? (
                                    <div className="quiz-empty">
                                        暂无收藏夹，请先同步数据
                                    </div>
                                ) : (
                                    <div className="quiz-table">
                                        {folders.map((f, i) => (
                                            <label
                                                key={f.media_id}
                                                className="quiz-row"
                                                data-selected={selectedFolderIds.has(f.media_id)}
                                            >
                                                <span className="quiz-row__idx">
                                                    {String(i + 1).padStart(2, "0")}
                                                </span>
                                                <input
                                                    type="checkbox"
                                                    className="quiz-row__check"
                                                    checked={selectedFolderIds.has(f.media_id)}
                                                    onChange={() => toggleFolder(f.media_id)}
                                                />
                                                <div className="quiz-row__main">
                                                    <div className="quiz-row__title">{f.title}</div>
                                                    <div className="quiz-row__sub">{f.media_count} 视频</div>
                                                </div>
                                                <span
                                                    className="quiz-row__badge"
                                                    data-tone={f.indexed_count > 0 ? "ok" : "no"}
                                                >
                                                    {f.indexed_count > 0 ? `${f.indexed_count} 入库` : "未入库"}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                )}

                                {!hasIndexedFolders && folders.length > 0 && !loadingFolders && (
                                    <p className="quiz-block__hint" data-tone="warn">
                                        <CircleAlert size={12} />
                                        需先将收藏夹入库，方可出题
                                    </p>
                                )}
                            </>
                        )}

                        {mode === "pages" && (
                            <>
                                {totalPageCount > 0 && (
                                    <div className="quiz-table__bar">
                                        <span className="quiz-table__bar-text">已向量化分P</span>
                                        <button className="quiz-table__bar-action" onClick={toggleAllPages}>
                                            {allPagesSelected ? "取消全选" : "全选"}
                                        </button>
                                    </div>
                                )}

                                {loadingPages ? (
                                    <div className="quiz-loading">
                                        <Loader2 size={16} className="animate-spin" />
                                        加载分P列表...
                                    </div>
                                ) : vectorizedPages.length === 0 ? (
                                    <div className="quiz-empty">
                                        暂无已入库分P
                                    </div>
                                ) : (
                                    <div className="quiz-table" style={{ maxHeight: "300px" }}>
                                        {vectorizedPages.map((p, i) => {
                                            const key = `${p.bvid}:${p.page_index}`;
                                            const isSelected = selectedPageKeys.has(key);
                                            return (
                                                <label
                                                    key={key}
                                                    className="quiz-row"
                                                    data-selected={isSelected}
                                                >
                                                    <span className="quiz-row__idx">
                                                        {String(i + 1).padStart(2, "0")}
                                                    </span>
                                                    <input
                                                        type="checkbox"
                                                        className="quiz-row__check"
                                                        checked={isSelected}
                                                        onChange={() => togglePage(p.bvid, p.page_index)}
                                                    />
                                                    <div className="quiz-row__main">
                                                        <div className="quiz-row__title">
                                                            {p.page_title || `P${p.page_index + 1}`}
                                                        </div>
                                                        <div className="quiz-row__sub">
                                                            {p.video_title || p.bvid}
                                                        </div>
                                                    </div>
                                                    <span className="quiz-row__badge" data-tone="ok">
                                                        {p.vector_chunk_count} 块
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </section>

                    <section className="quiz-block">
                        <div className="quiz-block__label">
                            <span className="quiz-block__num">II</span>
                            <span className="quiz-block__en">SPEC</span>
                            <span className="quiz-block__cn">规格</span>
                        </div>
                        <div className="quiz-spec">
                            <label className="quiz-spec__field">
                                <span className="quiz-spec__label">题数</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={questionCount}
                                    onChange={(e) => setQuestionCount(Number(e.target.value))}
                                    className="quiz-spec__input"
                                />
                            </label>
                            <label className="quiz-spec__field">
                                <span className="quiz-spec__label">难度</span>
                                <select
                                    value={difficulty}
                                    onChange={(e) => setDifficulty(e.target.value)}
                                    className="quiz-spec__select"
                                >
                                    <option value="easy">简单</option>
                                    <option value="medium">中等</option>
                                    <option value="hard">困难</option>
                                </select>
                            </label>
                        </div>
                    </section>

                    <button
                        className="quiz-cta"
                        disabled={generating || (mode === "folder" ? selectedFolderCount === 0 : selectedPageCount === 0)}
                        onClick={handleGenerate}
                    >
                        {generating ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                <span>AI 拟卷中</span>
                            </>
                        ) : (
                            <>
                                <span>生成题目</span>
                                <span className="quiz-cta__count">
                                    {mode === "folder" ? selectedFolderCount : selectedPageCount}
                                </span>
                                <ArrowRight size={16} />
                            </>
                        )}
                    </button>

                    <section className="quiz-block">
                        <div className="quiz-block__label">
                            <span className="quiz-block__num">III</span>
                            <span className="quiz-block__en">EXPORT</span>
                            <span className="quiz-block__cn">导出</span>
                        </div>
                        <div className="quiz-export">
                            {(["jsonl", "csv", "sft"] as const).map((fmt) => (
                                <button
                                    key={fmt}
                                    className="quiz-export__btn"
                                    onClick={() => handleExport(fmt)}
                                >
                                    <Download size={12} />
                                    {fmt}
                                </button>
                            ))}
                        </div>
                    </section>

                    <section className="quiz-block">
                        <button
                            className="quiz-block__label quiz-block__label--btn"
                            data-open={showHistory}
                            onClick={() => {
                                const willShow = !showHistory;
                                setShowHistory(willShow);
                                if (willShow) fetchHistory();
                            }}
                        >
                            <span className="quiz-block__num">IV</span>
                            <span className="quiz-block__en">ARCHIVE</span>
                            <span className="quiz-block__cn">历史</span>
                            <span className="quiz-block__caret" data-open={showHistory}>▸</span>
                        </button>

                        {showHistory && (
                            loadingHistory ? (
                                <div className="quiz-loading">
                                    <Loader2 size={14} className="animate-spin" />
                                    加载历史...
                                </div>
                            ) : historyItems.length === 0 ? (
                                <div className="quiz-empty">暂无历史</div>
                            ) : (
                                <div className="quiz-archive">
                                    {historyItems.map((item, i) => (
                                        <div
                                            key={item.quiz_uuid}
                                            className="quiz-archive__item"
                                            title={item.status === "failed" ? item.error_message || "题目生成失败" : undefined}
                                        >
                                            <span className="quiz-archive__idx">
                                                {String(i + 1).padStart(2, "0")}
                                            </span>
                                            <div className="quiz-archive__body">
                                                <div className="quiz-archive__title">{item.title}</div>
                                                <div className="quiz-archive__meta">
                                                    <span className="quiz-archive__q">
                                                        {item.question_count ?? item.total_question_count} 题
                                                    </span>
                                                    {item.status === "failed" ? (
                                                        <span className="quiz-archive__pill" data-tone="fail">失败</span>
                                                    ) : item.submission_uuid ? (
                                                        <span className="quiz-archive__pill" data-tone={item.passed ? "pass" : "fail"}>
                                                            {item.score != null ? `${item.score}分` : item.passed ? "通过" : "未通过"}
                                                        </span>
                                                    ) : (
                                                        <span className="quiz-archive__pill" data-tone="idle">未作答</span>
                                                    )}
                                                    {item.created_at && (
                                                        <span className="quiz-archive__date">
                                                            {new Date(item.created_at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="quiz-archive__actions">
                                                <button
                                                    className="quiz-archive__btn"
                                                    data-variant="primary"
                                                    onClick={() => handleRetakeQuiz(item.quiz_uuid)}
                                                >
                                                    重做
                                                </button>
                                                <button
                                                    className="quiz-archive__btn"
                                                    onClick={() => handleViewPastQuiz(item.quiz_uuid)}
                                                    title="查看"
                                                >
                                                    <Eye size={12} />
                                                </button>
                                                <button
                                                    className="quiz-archive__btn"
                                                    onClick={() => handleOpenShare(item.quiz_uuid)}
                                                    title="分享"
                                                >
                                                    <Share2 size={12} />
                                                </button>
                                                <button
                                                    className="quiz-archive__btn"
                                                    onClick={() => handleDownloadQuiz(item.quiz_uuid, item.title)}
                                                    title="下载"
                                                >
                                                    <Download size={12} />
                                                </button>
                                                <button
                                                    className="quiz-archive__btn"
                                                    data-variant="danger"
                                                    onClick={() => handleDeleteQuiz(item)}
                                                    disabled={deletingQuizUuid === item.quiz_uuid}
                                                    title="删除"
                                                >
                                                    {deletingQuizUuid === item.quiz_uuid ? (
                                                        <Loader2 size={12} className="animate-spin" />
                                                    ) : (
                                                        <Trash2 size={12} />
                                                    )}
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )
                        )}
                    </section>
                <ShareModal
                    open={!!shareModalUuid}
                    loading={shareLoading}
                    status={shareStatus}
                    error={shareError}
                    duration={shareDuration}
                    copied={copied}
                    onDurationChange={setShareDuration}
                    onCreate={handleCreateShare}
                    onRevoke={handleRevokeShare}
                    onCopy={handleCopyShareLink}
                    onClose={handleCloseShare}
                    shareUrl={shareStatus?.share_token ? shareUrl(shareStatus.share_token) : ""}
                />
                </div>
            ) : (
                <div>
                    <div className="quiz-run__head">
                        <div className="quiz-run__title-block">
                            <div>
                                {isReviewMode && <span className="quiz-run__chip">回看</span>}
                                <h4 className="quiz-run__title">{currentQuiz.title}</h4>
                            </div>
                            <div className="quiz-run__sub">
                                <span>{currentQuiz.question_count} 题</span>
                                <span className="quiz-history__meta-dot" />
                                <span>{DIFFICULTY_LABELS[currentQuiz.difficulty] || currentQuiz.difficulty}</span>
                                {currentQuiz.source_type === "pages" && (
                                    <>
                                        <span className="quiz-history__meta-dot" />
                                        <span>按分P</span>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="quiz-run__actions">
                            {!submitResult && !isReviewMode && (
                                <button
                                    className="quiz-btn"
                                    data-variant="primary"
                                    onClick={handleSubmit}
                                    disabled={!isAllAnswered || submitting}
                                >
                                    {submitting ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            批改中
                                        </>
                                    ) : (
                                        `交卷 · ${userAnswers.size}/${currentQuiz.questions.length}`
                                    )}
                                </button>
                            )}
                            {(submitResult || isReviewMode) && (
                                <button className="quiz-btn" onClick={handleBackToGenerate}>
                                    <ArrowLeft size={14} />
                                    返回
                                </button>
                            )}
                            <button
                                className="quiz-btn"
                                onClick={() => handleDownloadQuiz(currentQuiz.quiz_uuid, currentQuiz.title)}
                            >
                                <Download size={14} />
                                下载
                            </button>
                        </div>
                    </div>

                    {currentQuiz.questions.map((q, i) => {
                        const reviewResult: QuizAnswerResult | undefined = isReviewMode
                            ? {
                                  question_uuid: q.question_uuid,
                                  is_correct: null,
                                  auto_score: null,
                                  correct_answer: reviewCorrectAnswers.get(q.question_uuid) ?? "",
                              }
                            : undefined;
                        return (
                            <QuizQuestionCard
                                key={q.question_uuid}
                                index={i}
                                question={q}
                                userAnswer={userAnswers.get(q.question_uuid)}
                                result={
                                    submitResult?.results.find(
                                        (r) => r.question_uuid === q.question_uuid
                                    ) ?? reviewResult
                                }
                                disabled={!!submitResult || isReviewMode}
                                onAnswer={(uuid, ans) =>
                                    setUserAnswers((prev) => {
                                        const next = new Map(prev);
                                        next.set(uuid, ans);
                                        return next;
                                    })
                                }
                            />
                        );
                    })}

                    {submitResult && (
                        <ResultScorecard
                            result={submitResult}
                            onRetry={handleBackToGenerate}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/* ────── Question Card ────── */

function QuizQuestionCard({
    index,
    question,
    userAnswer,
    result,
    disabled,
    onAnswer,
}: {
    index: number;
    question: QuizQuestion;
    userAnswer?: string | string[];
    result?: QuizAnswerResult;
    disabled: boolean;
    onAnswer: (uuid: string, answer: string | string[]) => void;
}) {
    const isMulti = question.question_type === "multi_choice";
    const showResult = !!result;
    const isCorrect = result?.is_correct;
    const isPending = showResult && isCorrect === null;

    const cardState = !showResult
        ? "default"
        : isCorrect === true
        ? "correct"
        : isCorrect === false
        ? "wrong"
        : "pending";

    const feedbackTone =
        isCorrect === true ? "correct" : isCorrect === false ? "wrong" : "pending";

    const correctKeys = ((): string[] => {
        if (!showResult) return [];
        const ans = result!.correct_answer;
        const arr = Array.isArray(ans) ? ans : [String(ans)];
        return arr
            .map((s) => String(s).trim().toUpperCase()[0])
            .filter((c): c is string => !!c);
    })();

    const formatCorrectAnswer = (): string => {
        if (!result) return "";
        return Array.isArray(result.correct_answer)
            ? result.correct_answer.join(", ")
            : String(result.correct_answer);
    };

    return (
        <article
            className="quiz-card"
            data-type={question.question_type}
            data-state={cardState}
            style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
        >
            <header className="quiz-card__head">
                <span className="quiz-card__index">
                    Q{String(index + 1).padStart(2, "0")}
                </span>
                <span className="quiz-card__type">
                    {TYPE_LABELS[question.question_type] || question.question_type}
                </span>
                <span className="quiz-card__difficulty">
                    {DIFFICULTY_LABELS[question.difficulty] || question.difficulty}
                </span>
                {showResult && (
                    <span className="quiz-card__status">
                        {isCorrect === true ? (
                            <CheckCircle size={18} style={{ color: "var(--success)" }} />
                        ) : isCorrect === false ? (
                            <XCircle size={18} style={{ color: "var(--danger)" }} />
                        ) : null}
                    </span>
                )}
            </header>

            <p className="quiz-card__text">{question.question_text}</p>

            {question.options && question.options.length > 0 && (
                <div className="quiz-options">
                    {question.options.map((opt, i) => {
                        // Stable label derived from position (A, B, C, ...).
                        // Backend normalize outputs options as "A. text" / "B. text";
                        // we no longer rely on opt[0] so emoji / non-latin leading
                        // chars don't break selection matching.
                        const optKey = String.fromCharCode(65 + i);
                        const optLabel = opt.replace(/^[A-Z][\.\)、\s]+/, "");
                        const isSelected = Array.isArray(userAnswer)
                            ? userAnswer.includes(optKey)
                            : userAnswer === optKey;

                        let optState: "default" | "selected" | "correct" | "wrong" = "default";
                        if (showResult) {
                            if (correctKeys.includes(optKey)) optState = "correct";
                            else if (isSelected) optState = "wrong";
                        } else if (isSelected) {
                            optState = "selected";
                        }

                        return (
                            <label
                                key={optKey}
                                className="quiz-option"
                                data-selected={optState === "selected"}
                                data-state={optState === "correct" || optState === "wrong" ? optState : undefined}
                            >
                                <input
                                    type={isMulti ? "checkbox" : "radio"}
                                    className="quiz-option__native"
                                    name={`q-${question.question_uuid}`}
                                    checked={isSelected}
                                    disabled={disabled}
                                    onChange={() => {
                                        if (isMulti) {
                                            const arr = Array.isArray(userAnswer) ? [...userAnswer] : [];
                                            arr.includes(optKey)
                                                ? arr.splice(arr.indexOf(optKey), 1)
                                                : arr.push(optKey);
                                            onAnswer(question.question_uuid, arr);
                                        } else {
                                            onAnswer(question.question_uuid, optKey);
                                        }
                                    }}
                                />
                                <span className="quiz-option__badge">{optKey}</span>
                                <span className="quiz-option__text">{optLabel}</span>
                            </label>
                        );
                    })}
                </div>
            )}

            {!question.options && (
                <textarea
                    className="quiz-textarea"
                    placeholder="请输入答案..."
                    value={(userAnswer as string) ?? ""}
                    onChange={(e) => onAnswer(question.question_uuid, e.target.value)}
                    disabled={disabled}
                />
            )}

            {showResult && (
                <div className="quiz-feedback" data-tone={feedbackTone}>
                    <div className="quiz-feedback__line">
                        {isCorrect === true ? (
                            <span className="quiz-feedback__tag">✓ 正确</span>
                        ) : isCorrect === false ? (
                            <>
                                <span className="quiz-feedback__tag">✗ 错误</span>
                                <span className="quiz-feedback__answer-label">正确答案：</span>
                                <span className="quiz-feedback__answer">{formatCorrectAnswer()}</span>
                            </>
                        ) : (
                            <>
                                <span className="quiz-feedback__tag">待人工评分</span>
                                <span className="quiz-feedback__note">
                                    本题（{TYPE_LABELS[question.question_type] || question.question_type}）由 LLM 评分失败，已转入人工复核，暂不计入总分。
                                </span>
                            </>
                        )}
                        {result?.grading_note && isCorrect !== null && (
                            <span className="quiz-feedback__note">{result.grading_note}</span>
                        )}
                    </div>
                    {question.explanation && isCorrect !== null && (
                        <div className="quiz-feedback__explanation">
                            <span className="quiz-feedback__explanation-tag">解析</span>
                            {question.explanation}
                        </div>
                    )}
                </div>
            )}
        </article>
    );
}

/* ────── Result Scorecard ────── */

function ResultScorecard({
    result,
    onRetry,
}: {
    result: QuizSubmissionResult;
    onRetry: () => void;
}) {
    const passed = result.passed;
    const isPending = passed === null;
    const score = result.score ?? 0;
    const total = result.total_count || 1;
    const correct = result.correct_count;
    const ratio = Math.max(0, Math.min(1, score / 100));
    const RING_C = 2 * Math.PI * 52; // radius 52

    const stateAttr = isPending ? "pending" : passed === true ? "true" : "false";

    return (
        <div className="quiz-result" data-passed={stateAttr}>
            <span className="quiz-result__stamp">
                {isPending ? "待评分" : passed ? "Passed" : "Failed"}
            </span>

            <div className="quiz-result__ring">
                <svg width="120" height="120" viewBox="0 0 120 120">
                    <circle className="quiz-result__ring-bg" cx="60" cy="60" r="52" />
                    <circle
                        className="quiz-result__ring-fg"
                        cx="60"
                        cy="60"
                        r="52"
                        strokeDasharray={RING_C}
                        strokeDashoffset={RING_C * (1 - ratio)}
                    />
                </svg>
                <div className="quiz-result__score">
                    <span className="quiz-result__score-num">{score}</span>
                    <span className="quiz-result__score-unit">/ 100</span>
                </div>
            </div>

            <p className="quiz-result__verdict">
                {isPending
                    ? "部分题目待人工评分"
                    : passed
                    ? "考核通过"
                    : "未通过"}
            </p>
            <p className="quiz-result__detail">
                正确 <strong>{correct}</strong> / {total} · 得分率{" "}
                <strong>{Math.round(ratio * 100)}%</strong>
                {isPending && <span className="quiz-result__pending-hint">（essay 待评分，最终成绩以人工复核为准）</span>}
            </p>

            <div className="quiz-result__actions">
                <button className="quiz-btn" data-variant="primary" onClick={onRetry}>
                    再做一套
                </button>
            </div>
        </div>
    );
}

/* ────── Poll helper ────── */

async function pollUntilReady(
    quizUuid: string,
    maxRetries = 30,
): Promise<QuizSetData> {
    let delay = 2000;
    for (let i = 0; i < maxRetries; i++) {
        const quiz = await quizApi.getQuiz(quizUuid);
        // done = full set ready; partial = some questions ready, still answerable
        if (quiz.status === "done" || quiz.status === "partial") return quiz;
        if (quiz.status === "failed") throw new Error("题目生成失败");
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 16000);
    }
    throw new Error("题目生成超时");
}

interface ShareModalProps {
    open: boolean;
    loading: boolean;
    status: QuizShareStatus | null;
    error: string | null;
    duration: number | "";
    copied: boolean;
    onDurationChange: (v: number | "") => void;
    onCreate: () => void;
    onRevoke: () => void;
    onCopy: () => void;
    onClose: () => void;
    shareUrl: string;
}

function ShareModal({
    open,
    loading,
    status,
    error,
    duration,
    copied,
    onDurationChange,
    onCreate,
    onRevoke,
    onCopy,
    onClose,
    shareUrl,
}: ShareModalProps) {
    const isShared = status?.shared && !status.expired;
    const isExpired = status?.shared && status.expired;
    const isIdle = status && !isShared && !isExpired;

    const pillTone = isShared ? "live" : isExpired ? "expired" : "idle";
    const pillLabel = isShared ? "已分享 · 在线" : isExpired ? "已过期" : "未分享";

    const formatTime = (t?: string | null): string => {
        if (!t) return "—";
        const d = new Date(t);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent
                className="quiz-share-dialog sm:max-w-[460px] gap-0 p-0 overflow-hidden"
                showCloseButton
            >
                <header className="quiz-share__header">
                    <span className="quiz-share__icon-wrap">
                        <Share2 size={18} />
                    </span>
                    <DialogHeader className="gap-0">
                        <DialogTitle className="quiz-share__title">分享题目</DialogTitle>
                        <DialogDescription className="quiz-share__subtitle">
                            生成链接即可让他人在浏览器自测
                        </DialogDescription>
                    </DialogHeader>
                </header>

                <div className="quiz-share__body">
                    <span className="quiz-share__pill" data-tone={pillTone}>
                        {isShared ? (
                            <CheckCircle size={12} />
                        ) : isExpired ? (
                            <CircleAlert size={12} />
                        ) : (
                            <span className="quiz-share__pill-dot" />
                        )}
                        {pillLabel}
                    </span>

                    {loading && !status && (
                        <div className="quiz-share__loading">
                            <Loader2 size={16} className="animate-spin" />
                            加载分享状态...
                        </div>
                    )}

                    {error && (
                        <div className="quiz-share__callout" data-tone="error">
                            <span>{error}</span>
                        </div>
                    )}

                    {isIdle && (
                        <>
                            <p className="quiz-share__desc">
                                当前题目集未分享。生成链接后，任何人可通过链接查看题目用于自测（不含答案与解析）。
                            </p>
                            <div className="quiz-share__field">
                                <label className="quiz-share__label">有效期</label>
                                <div className="quiz-chips">
                                    {([
                                        { v: "", label: "永久" },
                                        { v: 1, label: "1 天" },
                                        { v: 7, label: "7 天" },
                                        { v: 30, label: "30 天" },
                                        { v: 365, label: "365 天" },
                                    ] as const).map((opt) => (
                                        <button
                                            key={String(opt.v)}
                                            type="button"
                                            className="quiz-chip"
                                            data-selected={duration === opt.v}
                                            onClick={() => onDurationChange(opt.v)}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <button
                                className="quiz-share__cta"
                                onClick={onCreate}
                                disabled={loading}
                            >
                                {loading ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        生成中...
                                    </>
                                ) : (
                                    <>
                                        <LinkIcon size={14} />
                                        生成分享链接
                                    </>
                                )}
                            </button>
                        </>
                    )}

                    {(isShared || isExpired) && status && (
                        <>
                            {isExpired && (
                                <div className="quiz-share__callout" data-tone="warning">
                                    <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                                    <span>此分享链接已过期，可重新生成以恢复访问。</span>
                                </div>
                            )}

                            <div className="quiz-ticket" data-state={isShared ? "live" : "expired"}>
                                <div className="quiz-ticket__head">
                                    <div className="quiz-ticket__title-row">
                                        <span className="quiz-ticket__icon">
                                            <LinkIcon size={13} />
                                        </span>
                                        <span className="quiz-ticket__label">分享链接</span>
                                    </div>
                                    {isShared && (
                                        <span className="quiz-ticket__badge">
                                            <span className="quiz-ticket__badge-dot" />
                                            LIVE
                                        </span>
                                    )}
                                </div>
                                <div className="quiz-ticket__url-row">
                                    <input
                                        readOnly
                                        className="quiz-ticket__url"
                                        value={shareUrl}
                                        onFocus={(e) => e.target.select()}
                                        aria-label="分享链接"
                                    />
                                </div>
                                <button
                                    className="quiz-ticket__copy"
                                    data-copied={copied}
                                    onClick={onCopy}
                                    title="复制链接"
                                >
                                    {copied ? (
                                        <>
                                            <CheckCircle size={14} />
                                            已复制
                                        </>
                                    ) : (
                                        <>
                                            <Copy size={14} />
                                            复制链接
                                        </>
                                    )}
                                </button>
                            </div>

                            <div className="quiz-share__meta">
                                <div className="quiz-share__meta-cell">
                                    <div className="quiz-share__meta-label">
                                        <Share2 size={11} />
                                        分享时间
                                    </div>
                                    <div className="quiz-share__meta-value">
                                        {formatTime(status.shared_at)}
                                    </div>
                                </div>
                                <div className="quiz-share__meta-cell">
                                    <div className="quiz-share__meta-label">
                                        <CircleAlert size={11} />
                                        过期时间
                                    </div>
                                    <div className="quiz-share__meta-value">
                                        {status.share_expires_at
                                            ? formatTime(status.share_expires_at)
                                            : "永不失效"}
                                    </div>
                                </div>
                            </div>

                            <div className="quiz-share__actions">
                                <button
                                    className="quiz-share__btn"
                                    onClick={onCreate}
                                    disabled={loading}
                                >
                                    {loading ? (
                                        <Loader2 size={13} className="animate-spin" />
                                    ) : (
                                        <LinkIcon size={13} />
                                    )}
                                    重新生成
                                </button>
                                <button
                                    className="quiz-share__btn"
                                    data-variant="danger"
                                    onClick={onRevoke}
                                    disabled={loading}
                                >
                                    <Trash2 size={13} />
                                    撤销分享
                                </button>
                            </div>
                        </>
                    )}
                </div>

                <footer className="quiz-share__footer">
                    <LinkIcon size={12} className="quiz-share__footer-icon" />
                    <span>
                        分享视图仅展示题目用于自测，不含正确答案与解析。重新生成或撤销会令旧链接立即失效。
                    </span>
                </footer>
            </DialogContent>
        </Dialog>
    );
}
