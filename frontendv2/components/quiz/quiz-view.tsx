"use client";

/**
 * QuizView - 题目练习列表页（/quiz）。
 *
 * 只负责列表：历史 + 新建练习对话框 + 生成提示 + 分享/导出/续跑入口。
 * 查看具体题卷走动态路由 /quiz/[uuid]（quiz-detail），选择题卷 = 路由跳转，
 * 可刷新、可分享、浏览器前进后退可用。
 * 兼容旧深链 /quiz?quiz=<uuid> → 自动 replace 到 /quiz/<uuid>。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Check, Loader2 } from "lucide-react";
import {
    quizApi,
    type QuizSetData,
} from "@/lib/api";
import { emitAppToast } from "@/lib/app-toast";
import { QuizList } from "./quiz-list";
import { GenerateDialog } from "./generate-dialog";
import { QuizShareDialog } from "./share-dialog";
import { ExportPaperDialog } from "./export-paper-dialog";

export function QuizView() {
    const router = useRouter();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [listRefreshKey, setListRefreshKey] = useState(0);
    // 后台生成已提交的轻提示（列表顶部，可关闭）
    const [notice, setNotice] = useState<string | null>(null);
    // 分享弹窗：非空 = 打开并针对该题卷
    const [shareQuizUuid, setShareQuizUuid] = useState<string | null>(null);
    // 试卷导出弹窗：非空 = 已加载完整题卷数据（含答案，供导出选项使用）
    const [exportQuiz, setExportQuiz] = useState<QuizSetData | null>(null);
    const [exportLoading, setExportLoading] = useState(false);

    // 兼容旧深链 /quiz?quiz=<uuid>（聊天页历史入口、旧分享文案）
    useEffect(() => {
        const param = new URLSearchParams(window.location.search).get("quiz");
        if (param) router.replace(`/quiz/${param}`);
    }, [router]);

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

    // 断点续跑：partial 卷从 checkpoint 补齐剩余题目；后端立即返回 generating，
    // 列表轮询自动接管进度；失败/中断不丢已保留题目，可再次续跑。
    const handleResume = useCallback(async (quizUuid: string) => {
        try {
            const res = await quizApi.resumeQuiz(quizUuid);
            if (res.status === "generating") {
                emitAppToast("success", `已从断点继续生成，剩余 ${res.remaining} 题`);
            } else if (res.status === "done") {
                emitAppToast("success", "续跑完成，题卷已补齐");
            } else {
                emitAppToast("warning", `续跑中断，已保留题目不受影响（剩余 ${res.remaining} 题），可再次续跑`);
            }
            setListRefreshKey((k) => k + 1);
        } catch (e) {
            emitAppToast("error", e instanceof Error ? e.message : "续跑失败");
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

    return (
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
            <QuizList
                onNew={() => {
                    setDialogOpen(true);
                }}
                onSelect={(quizUuid) => router.push(`/quiz/${quizUuid}`)}
                onShare={(quizUuid) => setShareQuizUuid(quizUuid)}
                onExport={openExport}
                onResume={handleResume}
                refreshKey={listRefreshKey}
            />
            <GenerateDialog
                open={dialogOpen}
                onClose={() => setDialogOpen(false)}
                onSubmitted={handleGenerationStarted}
            />

            {/* 测验分享弹窗（列表行触发） */}
            {shareQuizUuid && (
                <QuizShareDialog
                    open
                    quizUuid={shareQuizUuid}
                    onClose={() => setShareQuizUuid(null)}
                />
            )}

            {/* 试卷导出弹窗（列表行触发） */}
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


