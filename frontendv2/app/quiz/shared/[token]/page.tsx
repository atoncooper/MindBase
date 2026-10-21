"use client";

/**
 * Public shared quiz reading page (/quiz/shared/<token>). No auth, no NavBar.
 * Payload（app-quiz GetSharedQuiz）只含题目、不含答案/解析 —— 只读试卷视图。
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { quizApi, type SharedQuizData, type SharedQuizQuestion } from "@/lib/api/quiz";
import { AlertCircle, BookOpenCheck, ClipboardList, Loader2, Lock, Unlock } from "lucide-react";

const DIFF_LABEL: Record<string, string> = {
    easy: "简单",
    medium: "中等",
    hard: "困难",
};

const TYPE_LABEL: Record<string, string> = {
    single: "单选",
    multiple: "多选",
    judge: "判断",
    fill: "填空",
    short_answer: "问答",
};

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function optionLines(options: SharedQuizQuestion["options"]): [string, string][] {
    if (!options) return [];
    if (Array.isArray(options)) {
        return options.map((text, i) => [OPTION_LETTERS[i] ?? String(i + 1), text]);
    }
    return Object.entries(options);
}

export default function SharedQuizPage() {
    const params = useParams<{ token: string }>();
    const token = typeof params?.token === "string" ? params.token : "";

    const [data, setData] = useState<SharedQuizData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // 密码门：带口令的分享返回 401 → 展示密码表单，POST 验证后进入
    const [needPassword, setNeedPassword] = useState(false);
    const [password, setPassword] = useState("");
    const [pwBusy, setPwBusy] = useState(false);

    const load = async (pw?: string) => {
        if (!token) {
            setError("链接无效");
            setLoading(false);
            return;
        }
        try {
            const q = await quizApi.getSharedQuiz(token, pw);
            setData(q);
            setNeedPassword(false);
            setLoading(false);
        } catch (e) {
            const err = e as Error & { status?: number };
            if (err.status === 401) {
                setNeedPassword(true);
                setError(err.message || null);
            } else {
                setError(err.message || "分享链接无效或已失效");
            }
            setLoading(false);
        }
    };

    useEffect(() => {
        const t = setTimeout(() => void load(), 0);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    async function submitPassword() {
        if (!password.trim() || pwBusy) return;
        setPwBusy(true);
        setError(null);
        await load(password.trim());
        setPwBusy(false);
    }

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <Loader2 className="h-6 w-6 animate-spin text-tertiary" />
            </div>
        );
    }

    if (needPassword && !data) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                    <Lock className="h-6 w-6" />
                </span>
                <p className="mt-4 text-[15px] font-medium text-foreground">此分享已设置访问密码</p>
                <div className="mt-5 w-[300px]">
                    <input
                        autoFocus
                        type="password"
                        value={password}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            setError(null);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && password.trim()) void submitPassword();
                        }}
                        placeholder="输入访问密码"
                        className="field h-10 text-center text-[16px] md:text-[14px]"
                    />
                    {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
                    <button
                        type="button"
                        disabled={!password.trim() || pwBusy}
                        onClick={() => void submitPassword()}
                        className="btn-pill btn-primary mt-4 flex h-10 w-full text-[13px]"
                    >
                        {pwBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
                        查看试卷
                    </button>
                </div>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/5 text-danger">
                    <AlertCircle className="h-6 w-6" />
                </span>
                <p className="mt-4 text-[15px] font-medium text-foreground">{error ?? "分享不存在"}</p>
                <p className="mt-1.5 text-[13px] text-secondary">这条分享链接可能已过期或被撤销。</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background">
            <div className="mx-auto max-w-[760px] px-6 py-16 sm:px-10">
                <div className="mb-8 flex items-center gap-2 text-[11px] uppercase tracking-wider text-tertiary">
                    <BookOpenCheck className="h-3 w-3" />
                    <span>MindBase · 测验分享</span>
                </div>

                <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-foreground">
                    {data.title || "未命名测验"}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-secondary">
                    <span className="inline-flex items-center gap-1">
                        <ClipboardList className="h-3 w-3" />
                        {data.question_count} 题
                    </span>
                    {data.difficulty && <span>难度：{DIFF_LABEL[data.difficulty] ?? data.difficulty}</span>}
                    <span>总分 {data.total_score}</span>
                    <span>及格 {data.passing_score}</span>
                    {data.shared_at && (
                        <span>
                            {new Date(data.shared_at).toLocaleDateString("zh-CN", {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                            })}
                            　分享
                        </span>
                    )}
                </div>
                <hr className="my-8 border-border" />

                <ol className="space-y-6">
                    {data.questions.map((q, idx) => {
                        const lines = optionLines(q.options);
                        return (
                            <li
                                key={q.question_uuid ?? idx}
                                className="rounded-2xl border border-border bg-surface p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
                            >
                                <div className="flex items-start gap-3">
                                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-medium text-accent">
                                        {idx + 1}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                                            {q.question_text}
                                        </p>
                                        <div className="mt-2 flex gap-2 text-[11px] text-tertiary">
                                            <span>{TYPE_LABEL[q.question_type] ?? q.question_type}</span>
                                            <span>·</span>
                                            <span>{DIFF_LABEL[q.difficulty] ?? q.difficulty}</span>
                                        </div>
                                        {lines.length > 0 && (
                                            <ul className="mt-3 space-y-1.5">
                                                {lines.map(([k, v]) => (
                                                    <li
                                                        key={k}
                                                        className="flex gap-2 rounded-lg bg-border-subtle/40 px-3 py-1.5 text-[13px] text-secondary"
                                                    >
                                                        <span className="shrink-0 font-medium text-foreground/70">
                                                            {k}.
                                                        </span>
                                                        <span className="min-w-0 break-all">{v}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>

                <p className="mt-10 text-center text-[11px] text-tertiary">
                    通过 MindBase 公开分享 · 共 {data.question_count} 题
                </p>
            </div>
        </div>
    );
}
