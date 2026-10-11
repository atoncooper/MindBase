"use client";

/**
 * GenerateDialog - 新建练习全屏向导（Google Material 3 视觉）。
 *
 * 三步占满视口：
 *   1. source    - 出题来源（知识库 / AI 自由 / 错题强化 / 错题图片上传）+ 个性化出题面板
 *   2. config    - 题量 / 难度 / 标题
 *   3. generating- 轮询直至出题完成
 *
 * 顶部 M3 步骤条跟踪进度；底部导航按钮驱动上一步/下一步。
 * 成功后父级经 onGenerated 收到就绪题卷。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, AlertCircle, Check, ChevronLeft, ChevronRight, BookOpen, Sparkles, Target, ImagePlus, Wand2, Upload, FolderOpen, FileText } from "lucide-react";
import {
    quizApi,
    favoritesV2Api,
    skillsApi,
    type FavoriteFolderV2,
    type InstalledSkill,
    type QuizSetData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PaperStyle } from "@/lib/exam-paper";

interface GenerateDialogProps {
    open: boolean;
    onClose: () => void;
    onGenerated: (quiz: QuizSetData) => void;
}

const COUNTS = [5, 10, 15, 20];
const DIFFS = [
    { v: "easy", label: "简单" },
    { v: "medium", label: "中等" },
    { v: "hard", label: "困难" },
];

type Step = "source" | "config" | "generating";
const STEPS: { key: Step; label: string }[] = [
    { key: "source", label: "选择来源" },
    { key: "config", label: "出题配置" },
    { key: "generating", label: "生成题目" },
];

export function GenerateDialog({ open, onClose, onGenerated }: GenerateDialogProps) {
    return (
        <AnimatePresence>
            {open && (
                <DialogShell onClose={onClose}>
                    <DialogBody onClose={onClose} onGenerated={onGenerated} />
                </DialogShell>
            )}
        </AnimatePresence>
    );
}

function DialogShell({
    onClose,
    children,
}: {
    onClose: () => void;
    children: React.ReactNode;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return createPortal(
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="quiz-scope fixed inset-0 z-[100] flex flex-col bg-[#f0f4f9]"
        >
            {children}
        </motion.div>,
        document.body,
    );
}

/** M3 步骤条：编号圆 + 连接线，完成态实心主色。 */
function Stepper({ current }: { current: number }) {
    return (
        <div className="flex items-center">
            {STEPS.map((s, i) => {
                const done = i < current;
                const active = i === current;
                return (
                    <div
                        key={s.key}
                        className={cn(
                            "flex items-center",
                            i < STEPS.length - 1 && "flex-1",
                        )}
                    >
                        <div className="flex flex-col items-center gap-1.5">
                            <span
                                className={cn(
                                    "grid h-8 w-8 place-items-center rounded-full border-2 text-[13px] font-medium transition-colors",
                                    done && "border-[#0b57d0] bg-[#0b57d0] text-white",
                                    active && "border-[#0b57d0] bg-[#d3e3fd] text-[#041e49]",
                                    !done && !active && "border-[#c4c7c5] bg-white text-[#747775]",
                                )}
                            >
                                {done ? <Check className="h-4 w-4" /> : i + 1}
                            </span>
                            <span
                                className={cn(
                                    "text-[12px] tracking-normal transition-colors",
                                    active
                                        ? "font-medium text-[#0b57d0]"
                                        : done
                                          ? "text-[#1f1f1f]"
                                          : "text-[#747775]",
                                )}
                            >
                                {s.label}
                            </span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <div
                                className={cn(
                                    "mx-3 mb-5 h-[2px] flex-1 rounded-full transition-colors",
                                    done ? "bg-[#0b57d0]" : "bg-[#c4c7c5]",
                                )}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function DialogBody({
    onClose,
    onGenerated,
}: {
    onClose: () => void;
    onGenerated: (quiz: QuizSetData) => void;
}) {
    const [folders, setFolders] = useState<FavoriteFolderV2[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [count, setCount] = useState(10);
    const [difficulty, setDifficulty] = useState("medium");
    const [title, setTitle] = useState("");
    const [loadingFolders, setLoadingFolders] = useState(true);
    // 出题模式:kb=知识库检索(原能力) / free=AI 围绕主题自由出题 / wrong=错题强化 /
    // image=错题图片/文件上传(OCR 识别后强化或模仿出题)
    const [mode, setMode] = useState<"kb" | "free" | "wrong" | "image">("kb");
    const [topic, setTopic] = useState("");
    // 上传出题(image 模式)
    const [files, setFiles] = useState<File[]>([]);
    const [imageMode, setImageMode] = useState<"wrong_images" | "mimic">("wrong_images");
    // 个性化出题(全模式可用)
    const [personalOpen, setPersonalOpen] = useState(false);
    const [paperStyle, setPaperStyle] = useState<PaperStyle>("standard");
    const [skillIds, setSkillIds] = useState<string[]>([]);
    const [instructions, setInstructions] = useState("");
    const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);

    const [step, setStep] = useState<Step>("source");
    const [error, setError] = useState<string | null>(null);
    const [pollUuid, setPollUuid] = useState<string | null>(null);
    // checkpoint 进度：轮询时后端已增量落库的题数（generating 期可见）
    const [generatedCount, setGeneratedCount] = useState(0);

    // Load favorite folders once.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await favoritesV2Api.listFolders();
                if (cancelled) return;
                setFolders(list);
                // Pre-select folders already marked selected on the server.
                setSelected(
                    new Set(
                        list.filter((f) => f.is_selected).map((f) => f.media_id),
                    ),
                );
            } catch {
                // Leave empty; user will see the empty hint.
            } finally {
                if (!cancelled) setLoadingFolders(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Poll quiz status until done/partial/failed.
    useEffect(() => {
        if (!pollUuid) return;
        let cancelled = false;
        (async () => {
            while (!cancelled) {
                try {
                    const q = await quizApi.getQuiz(pollUuid);
                    if (cancelled) return;
                    if (q.status === "done" || q.status === "partial") {
                        onGenerated(q);
                        return;
                    }
                    if (q.status === "failed") {
                        setStep("config");
                        setError(q.error_message || "题目生成失败，请重试");
                        return;
                    }
                    // checkpoint 进度：已增量落库的题数
                    setGeneratedCount(q.questions?.length ?? 0);
                } catch {
                    if (cancelled) return;
                    setStep("config");
                    setError("查询生成状态失败，请重试");
                    return;
                }
                await new Promise((r) => setTimeout(r, 2000));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pollUuid, onGenerated]);

    // 个性化面板展开时懒加载已安装技能
    useEffect(() => {
        if (!personalOpen || installedSkills.length > 0) return;
        let cancelled = false;
        (async () => {
            try {
                const list = await skillsApi.listInstalled();
                if (!cancelled) setInstalledSkills(list.filter((s) => s.enabled));
            } catch {
                // 技能服务不可用：面板仍可用（技能列表为空）
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [personalOpen, installedSkills.length]);

    const personalization = {
        style: paperStyle,
        ...(skillIds.length ? { skill_ids: skillIds } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    };

    const stepIndex = STEPS.findIndex((s) => s.key === step);

    function toggleFolder(mediaId: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(mediaId)) next.delete(mediaId);
            else next.add(mediaId);
            return next;
        });
    }

    function addFiles(incoming: FileList | File[] | null) {
        if (!incoming) return;
        const list = Array.from(incoming);
        setFiles((prev) => {
            const merged = [...prev];
            for (const f of list) {
                if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f);
            }
            return merged.slice(0, 10);
        });
        setError(null);
    }

    function removeFile(name: string) {
        setFiles((prev) => prev.filter((f) => f.name !== name));
    }

    async function startGenerate() {
        setStep("generating");
        setError(null);
        setGeneratedCount(0);
        try {
            const res =
                mode === "image" ? (
                    await quizApi.generateFromImages((() => {
                        const form = new FormData();
                        form.append("mode", imageMode);
                        form.append("question_count", String(count));
                        form.append("difficulty", difficulty);
                        if (title.trim()) form.append("title", title.trim());
                        if (topic.trim()) form.append("topic", topic.trim());
                        if (paperStyle !== "standard") form.append("style", paperStyle);
                        if (skillIds.length) form.append("skill_ids", skillIds.join(","));
                        if (instructions.trim()) form.append("instructions", instructions.trim());
                        for (const f of files) form.append("files", f, f.name);
                        return form;
                    })())
                )
                : mode === "kb" ? (
                    await quizApi.generate({
                        folder_ids: Array.from(selected),
                        question_count: count,
                        difficulty,
                        title: title.trim() || undefined,
                        ...personalization,
                    })
                )
                : (
                    await quizApi.generateAI({
                        mode: mode === "wrong" ? "wrong_answers" : "free",
                        topic: topic.trim() || undefined,
                        question_count: count,
                        difficulty,
                        title: title.trim() || undefined,
                        ...personalization,
                    })
                );
            setPollUuid(res.quiz_uuid);
        } catch (e) {
            setStep("config");
            setError(e instanceof Error ? e.message : "出题请求失败");
        }
    }

    const canNextFromSource =
        mode === "kb"
            ? selected.size > 0
            : mode === "free"
              ? topic.trim().length > 0
              : mode === "image"
                ? files.length > 0
                : true;

    const sourceSummary =
        mode === "kb"
            ? folders
                    .filter((f) => selected.has(f.media_id))
                    .map((f) => f.title)
                    .join("、") || "未选择"
            : mode === "free"
              ? topic.trim() || "未填写主题"
              : mode === "image"
                ? files.length > 0
                    ? files.length + " 个文件：" + files.map((f) => f.name).slice(0, 3).join("、") + (files.length > 3 ? " 等" : "")
                    : "未上传文件"
                : "历史错题薄弱点（AI 读取错题本，由易到难出变式新题）";

    const sourceLabel =
        mode === "kb"
            ? selected.size + " 个收藏夹"
            : mode === "free"
              ? "AI 自由出题"
              : mode === "image"
                ? imageMode === "mimic"
                    ? "模仿出题"
                    : "错题图片强化"
                : "错题强化";

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-4 md:px-10">
                <h2 className="text-[18px] font-medium tracking-normal text-[#1f1f1f]">新建练习</h2>
                <button type="button" onClick={onClose} className="g-icon-btn" aria-label="关闭">
                    <X className="h-[18px] w-[18px]" />
                </button>
            </header>

            {/* Stepper */}
            <div className="mx-auto w-full max-w-[680px] px-6 pb-6">
                <Stepper current={stepIndex} />
            </div>

            {/* Content (fills viewport) */}
            <div className="relative flex-1 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                    {step === "source" && (
                        <motion.div
                            key="source"
                            initial={{ opacity: 0, x: 16 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -16 }}
                            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                            className="h-full overflow-y-auto"
                        >
                            <div className="mx-auto max-w-[680px] px-6 pb-8">
                                {/* 出题模式（M3 卡片 + 主色圆图标） */}
                                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                                    {([
                                        { v: "kb", label: "知识库出题", desc: "检索已向量化视频", icon: BookOpen },
                                        { v: "free", label: "AI 自由出题", desc: "任意主题，无需知识库", icon: Sparkles },
                                        { v: "wrong", label: "错题强化", desc: "基于错题本由易到难", icon: Target },
                                        { v: "image", label: "错题图片", desc: "上传错题/试卷强化出题", icon: ImagePlus },
                                    ] as const).map((m) => {
                                        const active = mode === m.v;
                                        return (
                                            <button
                                                key={m.v}
                                                type="button"
                                                onClick={() => {
                                                    setMode(m.v);
                                                    setError(null);
                                                }}
                                                className={cn(
                                                    "flex flex-col items-start gap-1.5 rounded-2xl border px-3.5 py-3.5 text-left transition-all",
                                                    active
                                                        ? "border-[#0b57d0] bg-white shadow-[0_1px_2px_0_rgba(60,64,67,.30)]"
                                                        : "border-[#c4c7c5] bg-white hover:bg-[rgba(31,31,31,0.03)]",
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "grid h-8 w-8 place-items-center rounded-full",
                                                        active ? "bg-[#0b57d0] text-white" : "bg-[#d3e3fd] text-[#041e49]",
                                                    )}
                                                >
                                                    <m.icon className="h-4 w-4" aria-hidden="true" />
                                                </span>
                                                <span className="text-[13px] font-medium text-[#1f1f1f]">{m.label}</span>
                                                <span className="text-[11px] leading-snug text-[#444746]">{m.desc}</span>
                                            </button>
                                        );
                                    })}
                                </div>

                                {mode === "kb" && (
                                    <>
                                        <p className="mt-5 text-[13px] text-[#444746]">
                                            选择作为出题来源的收藏夹，可多选。仅已向量化的内容会被检索。
                                        </p>
                                        <div className="g-card mt-3 divide-y divide-[#c4c7c5] overflow-hidden">
                                            {loadingFolders ? (
                                                <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[#747775]">
                                                    <Loader2 className="h-4 w-4 animate-spin text-[#0b57d0]" />
                                                    加载收藏夹…
                                                </div>
                                            ) : folders.length === 0 ? (
                                                <div className="flex flex-col items-center gap-2 py-14 text-center">
                                                    <FolderOpen className="h-7 w-7 text-[#747775]" />
                                                    <p className="text-[13px] text-[#444746]">暂无收藏夹，请先在收藏夹页同步</p>
                                                </div>
                                            ) : (
                                                folders.map((f) => {
                                                    const active = selected.has(f.media_id);
                                                    return (
                                                        <button
                                                            key={f.media_id}
                                                            type="button"
                                                            onClick={() => toggleFolder(f.media_id)}
                                                            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[rgba(31,31,31,0.03)]"
                                                        >
                                                            <span
                                                                className={cn(
                                                                    "g-check",
                                                                    active && "g-check-selected",
                                                                )}
                                                            >
                                                                {active && <Check className="h-3 w-3" />}
                                                            </span>
                                                            <FileText className="h-4 w-4 shrink-0 text-[#747775]" />
                                                            <span className="min-w-0 flex-1 truncate text-[14px] text-[#1f1f1f]">
                                                                {f.title}
                                                            </span>
                                                            <span className="shrink-0 text-[12px] text-[#747775]">
                                                                {f.media_count}
                                                            </span>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </>
                                )}

                                {mode === "free" && (
                                    <div className="mt-5">
                                        <label className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                            出题主题
                                        </label>
                                        <textarea
                                            value={topic}
                                            onChange={(e) => setTopic(e.target.value)}
                                            className="g-field mt-2.5 min-h-[88px] resize-none"
                                            placeholder="如：Java 并发编程、线性代数特征值、考研英语长难句…（可留空描述方向）"
                                            maxLength={300}
                                        />
                                        <p className="mt-2 text-[11px] text-[#747775]">AI 将围绕主题自主设计题目，无需知识库材料。</p>
                                    </div>
                                )}
                                {mode === "wrong" && (
                                    <div className="g-card mt-5 border-l-4 !border-l-[#0b57d0] px-4 py-3.5">
                                        <div className="flex items-center gap-2 text-[13px] font-medium text-[#1f1f1f]">
                                            <Target className="h-4 w-4 text-[#0b57d0]" aria-hidden="true" />
                                            错题强化训练
                                        </div>
                                        <p className="mt-1.5 text-[12px] leading-relaxed text-[#444746]">
                                            AI 会读取你的错题本，针对错误次数最多的薄弱知识点出由易到难的变式新题（先 easy 巩固、后 hard 拔高）。
                                        </p>
                                    </div>
                                )}

                                {mode === "image" && (
                                    <div className="mt-5">
                                        {/* 强化 / 模仿（M3 单选卡） */}
                                        <div className="grid grid-cols-2 gap-2">
                                            {(
                                                [
                                                    { v: "wrong_images", label: "错题强化", desc: "识别错题暴露的薄弱点，出变式新题" },
                                                    { v: "mimic", label: "模仿出题", desc: "仿照上传试卷的题型与风格出新题" },
                                                ] as const
                                            ).map((m) => {
                                                const active = imageMode === m.v;
                                                return (
                                                    <button
                                                        key={m.v}
                                                        type="button"
                                                        onClick={() => setImageMode(m.v)}
                                                        className={cn(
                                                            "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-all",
                                                            active
                                                                ? "border-[#0b57d0] bg-[rgba(211,227,253,0.35)]"
                                                                : "border-[#c4c7c5] bg-white hover:bg-[rgba(31,31,31,0.03)]",
                                                        )}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "g-radio mt-0.5",
                                                                active && "g-radio-selected",
                                                            )}
                                                        />
                                                        <span className="min-w-0">
                                                            <span className="block text-[13px] font-medium text-[#1f1f1f]">{m.label}</span>
                                                            <span className="block text-[11px] leading-snug text-[#444746]">{m.desc}</span>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        {/* 上传区（Google Drive 式虚线卡） */}
                                        <label
                                            onDragOver={(e) => e.preventDefault()}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                addFiles(e.dataTransfer.files);
                                            }}
                                            className="mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-[#c4c7c5] bg-white px-4 py-9 text-center transition-colors hover:border-[#0b57d0] hover:bg-[rgba(211,227,253,0.18)]"
                                        >
                                            <span className="grid h-11 w-11 place-items-center rounded-full bg-[#d3e3fd]">
                                                <Upload className="h-5 w-5 text-[#041e49]" aria-hidden="true" />
                                            </span>
                                            <span className="text-[14px] font-medium text-[#1f1f1f]">
                                                点击或拖拽上传错题照片 / 试卷文件
                                            </span>
                                            <span className="text-[11px] text-[#747775]">
                                                支持图片（png / jpg / webp）与 pdf / docx / txt / md，最多 10 个，单个 ≤10MB
                                            </span>
                                            <input
                                                type="file"
                                                multiple
                                                accept="image/png,image/jpeg,image/webp,image/bmp,.pdf,.docx,.pptx,.txt,.md,.markdown,.html,.htm"
                                                className="sr-only"
                                                onChange={(e) => {
                                                    addFiles(e.target.files);
                                                    e.target.value = "";
                                                }}
                                            />
                                        </label>

                                        {/* 已选文件 */}
                                        {files.length > 0 && (
                                            <div className="mt-3 space-y-1.5">
                                                {files.map((f) => (
                                                    <div
                                                        key={f.name + f.size}
                                                        className="g-card flex items-center gap-2.5 px-3.5 py-2.5"
                                                    >
                                                        <FileText className="h-4 w-4 shrink-0 text-[#0b57d0]" />
                                                        <span className="min-w-0 flex-1 truncate text-[13px] text-[#1f1f1f]">
                                                            {f.name}
                                                        </span>
                                                        <span className="shrink-0 text-[11px] text-[#747775]">
                                                            {(f.size / 1024 / 1024).toFixed(2)}MB
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeFile(f.name)}
                                                            className="g-icon-btn !h-7 !w-7 shrink-0"
                                                            aria-label={"移除 " + f.name}
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <p className="mt-3 text-[11px] leading-relaxed text-[#747775]">
                                            图片将通过视觉模型识别文字后由 AI 提取题目与知识点；识别与生成约需 1-2 分钟，请耐心等待。
                                        </p>
                                    </div>
                                )}

                                {/* 个性化出题（全模式可用，默认折叠） */}
                                <div className="g-card mt-5 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setPersonalOpen((v) => !v)}
                                        className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition-colors hover:bg-[rgba(31,31,31,0.03)]"
                                    >
                                        <Wand2 className="h-[18px] w-[18px] text-[#0b57d0]" aria-hidden="true" />
                                        <span className="flex-1 text-[14px] font-medium text-[#1f1f1f]">
                                            个性化出题
                                            {(paperStyle !== "standard" || skillIds.length > 0 || instructions.trim()) && (
                                                <span className="ml-2 rounded-full bg-[#d3e3fd] px-2 py-0.5 text-[10px] font-medium text-[#041e49]">
                                                    已配置
                                                </span>
                                            )}
                                        </span>
                                        <span className="text-[12px] text-[#0b57d0]">{personalOpen ? "收起" : "展开"}</span>
                                    </button>
                                    {personalOpen && (
                                        <div className="space-y-5 border-t border-[#c4c7c5] px-4 py-4">
                                            <div>
                                                <p className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                                    试卷风格
                                                </p>
                                                <div className="mt-2 flex flex-wrap gap-1.5">
                                                    {(
                                                        [
                                                            { v: "standard", label: "标准练习" },
                                                            { v: "gaokao", label: "高考风格" },
                                                            { v: "kaoyan", label: "考研风格" },
                                                        ] as Array<{ v: PaperStyle; label: string }>
                                                    ).map((s) => (
                                                        <button
                                                            key={s.v}
                                                            type="button"
                                                            onClick={() => setPaperStyle(s.v)}
                                                            className={cn(
                                                                "g-chip",
                                                                paperStyle === s.v && "g-chip-selected",
                                                            )}
                                                        >
                                                            {s.label}
                                                        </button>
                                                    ))}
                                                </div>
                                                <p className="mt-1.5 text-[11px] text-[#747775]">
                                                    影响题型用语、设问习惯与评分口径；导出时可再选卷面版式。
                                                </p>
                                            </div>

                                            <div>
                                                <p className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                                    加载技能（Skills）
                                                </p>
                                                {installedSkills.length === 0 ? (
                                                    <p className="mt-2 text-[12px] text-[#747775]">
                                                        暂无已安装技能，可在「技能」页安装后用于出题。
                                                    </p>
                                                ) : (
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        {installedSkills.map((s) => {
                                                            const active = skillIds.includes(s.skill_id);
                                                            return (
                                                                <button
                                                                    key={s.skill_id}
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setSkillIds((prev) =>
                                                                            active
                                                                                ? prev.filter((x) => x !== s.skill_id)
                                                                                : prev.length >= 5
                                                                                  ? prev
                                                                                  : [...prev, s.skill_id],
                                                                        )
                                                                    }
                                                                    className={cn(
                                                                        "g-chip",
                                                                        active && "g-chip-selected",
                                                                    )}
                                                                >
                                                                    {s.name}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                <p className="mt-1.5 text-[11px] text-[#747775]">
                                                    选中技能的完整指令将注入出题提示词（最多 5 个）。
                                                </p>
                                            </div>

                                            <div>
                                                <p className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                                    自定义提示词
                                                </p>
                                                <textarea
                                                    value={instructions}
                                                    onChange={(e) => setInstructions(e.target.value)}
                                                    className="g-field mt-2 min-h-[72px] resize-none"
                                                    placeholder="如：多出计算题、结合最新考纲、题干用反问句式…"
                                                    maxLength={2000}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {error && (
                                    <div className="g-banner mt-4">
                                        <AlertCircle className="h-4 w-4 shrink-0 text-[#d93025]" />
                                        {error}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}

                    {step === "config" && (
                        <motion.div
                            key="config"
                            initial={{ opacity: 0, x: 16 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -16 }}
                            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                            className="h-full overflow-y-auto"
                        >
                            <div className="mx-auto max-w-[680px] px-6 pb-8">
                                {/* 来源摘要 */}
                                <div className="g-card px-4 py-3.5">
                                    <div className="text-[11px] font-medium uppercase tracking-wider text-[#747775]">
                                        来源 · {sourceLabel}
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-[13px] text-[#1f1f1f]">{sourceSummary}</div>
                                </div>

                                {/* 题量 */}
                                <div className="mt-7">
                                    <label className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                        题目数量
                                    </label>
                                    <div className="mt-2.5 grid grid-cols-4 gap-2">
                                        {COUNTS.map((c) => (
                                            <button
                                                key={c}
                                                type="button"
                                                onClick={() => setCount(c)}
                                                className={cn(
                                                    "h-11 rounded-xl border text-[14px] font-medium transition-all",
                                                    count === c
                                                        ? "border-[#0b57d0] bg-[#0b57d0] text-white shadow-[0_1px_2px_0_rgba(60,64,67,.30)]"
                                                        : "border-[#c4c7c5] bg-white text-[#1f1f1f] hover:bg-[rgba(31,31,31,0.03)]",
                                                )}
                                            >
                                                {c}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* 难度 */}
                                <div className="mt-7">
                                    <label className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                        难度
                                    </label>
                                    <div className="mt-2.5 grid grid-cols-3 gap-2">
                                        {DIFFS.map((d) => (
                                            <button
                                                key={d.v}
                                                type="button"
                                                onClick={() => setDifficulty(d.v)}
                                                className={cn(
                                                    "h-11 rounded-xl border text-[14px] font-medium transition-all",
                                                    difficulty === d.v
                                                        ? "border-[#0b57d0] bg-[#0b57d0] text-white shadow-[0_1px_2px_0_rgba(60,64,67,.30)]"
                                                        : "border-[#c4c7c5] bg-white text-[#1f1f1f] hover:bg-[rgba(31,31,31,0.03)]",
                                                )}
                                            >
                                                {d.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* 标题 */}
                                <div className="mt-7">
                                    <label className="text-[12px] font-medium uppercase tracking-wider text-[#747775]">
                                        标题（可选）
                                    </label>
                                    <input
                                        value={title}
                                        onChange={(e) => setTitle(e.target.value)}
                                        className="g-field mt-2.5"
                                        placeholder="如：操作系统复习"
                                        maxLength={60}
                                    />
                                </div>

                                {error && (
                                    <div className="g-banner mt-5">
                                        <AlertCircle className="h-4 w-4 shrink-0 text-[#d93025]" />
                                        {error}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}

                    {step === "generating" && (
                        <motion.div
                            key="generating"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.22 }}
                            className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center"
                        >
                            <div className="relative grid place-items-center">
                                <span className="absolute h-16 w-16 animate-ping rounded-full bg-[#d3e3fd]" />
                                <Loader2 className="h-10 w-10 animate-spin text-[#0b57d0]" />
                            </div>
                            <div>
                                <p className="text-[16px] font-medium text-[#1f1f1f]">正在生成题目…</p>
                                <p className="mt-1.5 text-[13px] text-[#747775]">
                                    {mode === "image"
                                        ? "识别图片并结构化提取后由 AI 出题，约需 1-2 分钟"
                                        : "基于来源检索与出题，通常需要 10-30 秒"}
                                </p>
                            </div>
                            {/* checkpoint 进度：分批落库，已生成 X/N */}
                            <div className="w-full max-w-[340px]">
                                <div className="g-progress">
                                    <div
                                        style={{
                                            width:
                                                Math.min(100, Math.round((generatedCount / Math.max(1, count)) * 100)) + "%",
                                        }}
                                    />
                                </div>
                                <p className="mt-2 text-[12px] text-[#444746]">
                                    {generatedCount > 0
                                        ? "已生成 " + generatedCount + " / " + count + " 题"
                                        : "正在准备第一批…"}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-[#444746]">
                                <span>{count} 题</span>
                                <span className="h-3 w-px bg-[#c4c7c5]" />
                                <span>{DIFFS.find((d) => d.v === difficulty)?.label}</span>
                                <span className="h-3 w-px bg-[#c4c7c5]" />
                                <span>{sourceLabel}</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Footer nav */}
            <footer className="border-t border-[#c4c7c5]">
                <div className="mx-auto flex w-full max-w-[680px] items-center justify-between px-6 py-4">
                    {step === "source" && (
                        <>
                            <button type="button" onClick={onClose} className="g-btn g-btn-text">
                                取消
                            </button>
                            <button
                                type="button"
                                disabled={!canNextFromSource}
                                onClick={() => {
                                    setError(null);
                                    setStep("config");
                                }}
                                className="g-btn g-btn-filled"
                            >
                                下一步
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </>
                    )}

                    {step === "config" && (
                        <>
                            <button
                                type="button"
                                onClick={() => {
                                    setError(null);
                                    setStep("source");
                                }}
                                className="g-btn g-btn-text"
                            >
                                <ChevronLeft className="h-4 w-4" />
                                上一步
                            </button>
                            <button type="button" onClick={startGenerate} className="g-btn g-btn-filled">
                                开始生成
                            </button>
                        </>
                    )}

                    {step === "generating" && (
                        <>
                            <span className="text-[12px] text-[#747775]">生成中，请勿关闭</span>
                            <button type="button" onClick={onClose} className="g-btn g-btn-text">
                                取消
                            </button>
                        </>
                    )}
                </div>
            </footer>
        </div>
    );
}
