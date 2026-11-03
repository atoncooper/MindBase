"use client";

/**
 * 科研工作台共享 UI 片段：阶段/状态/类型的中文文案映射，以及卡片、徽标、
 * 错误条、空态、加载态和 Apple 风格弹窗。
 *
 * 文案集中在此，避免四个 Tab 各自维护一份中文标签而漂移；样式沿用现有
 * Apple 语义色（bg-surface / border-border / text-secondary / accent）。
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Loader2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
    AcademicDocumentKind,
    AcademicPaperType,
    AcademicStage,
    AcademicStageStatus,
} from "@/lib/api";

/** 阶段顺序（与后端 ACADEMIC_STAGES 一致）。 */
export const STAGE_ORDER: AcademicStage[] = [
    "topic",
    "design",
    "advise",
    "experiment",
    "writing",
    "submission",
];

export const STAGE_LABELS: Record<AcademicStage, string> = {
    topic: "选题",
    design: "研究设计",
    advise: "指导",
    experiment: "实验",
    writing: "写作",
    submission: "投稿",
};

export const STAGE_SHORT_LABELS: Record<AcademicStage, string> = {
    topic: "选题",
    design: "设计",
    advise: "指导",
    experiment: "实验",
    writing: "写作",
    submission: "投稿",
};

export const STAGE_STATUS_LABELS: Record<AcademicStageStatus, string> = {
    locked: "未开始",
    active: "进行中",
    submitted: "待确认",
    approved: "已确认",
    frozen: "已冻结",
};

/** 状态徽标配色：进行中=强调色、待确认=橙、已确认=绿、冻结/未开始=灰。 */
export const STAGE_STATUS_STYLES: Record<AcademicStageStatus, string> = {
    locked: "bg-border-subtle text-tertiary",
    active: "bg-accent-soft text-accent",
    submitted: "bg-warning/10 text-warning",
    approved: "bg-success/10 text-success",
    frozen: "bg-border text-secondary",
};

export const PAPER_TYPE_LABELS: Record<AcademicPaperType, string> = {
    journal: "期刊论文",
    thesis: "学位论文",
    fund: "基金申请",
};

export const DOC_KIND_LABELS: Record<AcademicDocumentKind, string> = {
    proposal: "开题报告",
    plan: "研究计划",
    draft: "初稿",
    revision: "修改稿",
    cover_letter: "投稿信",
    custom: "自定义",
};

export const DOC_KIND_ORDER: AcademicDocumentKind[] = [
    "proposal",
    "plan",
    "draft",
    "revision",
    "cover_letter",
    "custom",
];

/** 事件类型中文标签（后端 payload 不变；未知类型原样显示）。 */
export const EVENT_LABELS: Record<string, string> = {
    "project.created": "创建项目",
    "project.updated": "更新项目",
    "stage.updated": "阶段更新",
    "advice.saved": "保存阶段建议",
    "plan.updated": "更新阶段计划",
    "literature.imported": "导入文献",
    "literature.added": "新增文献",
    "literature.verified": "核验文献",
    "literature.removed": "移除文献",
    "manuscript.document_created": "新建写作文档",
    "manuscript.section_saved": "保存章节",
    "manuscript.outline_updated": "调整章节结构",
};

/** 文献来源中文标签。 */
export const LITERATURE_SOURCE_LABELS: Record<string, string> = {
    crossref: "Crossref",
    openalex: "OpenAlex",
    arxiv: "arXiv",
    manual: "手工录入",
    bibtex: "BibTeX 导入",
    csl: "CSL 导入",
};

export function formatDate(ms?: number): string {
    if (!ms) return "未设置";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "未设置";
    return d.toISOString().slice(0, 10);
}

export function formatDateTime(ms?: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 复制到剪贴板；失败返回 false（不抛，由调用方提示）。 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 非安全上下文 / 权限拒绝时回退到 execCommand
    }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}

/** 触发浏览器下载（内容导出：BibTeX / Markdown / LaTeX）。 */
export function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8"): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/** 小号状态徽标。 */
export function StatusBadge({ status, className }: { status: AcademicStageStatus; className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                STAGE_STATUS_STYLES[status],
                className,
            )}
        >
            {STAGE_STATUS_LABELS[status]}
        </span>
    );
}

/** 通用浅色标签（类型、来源等）。 */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full bg-border-subtle px-2 py-0.5 text-[11px] text-secondary",
                className,
            )}
        >
            {children}
        </span>
    );
}

/** 内联错误条：统一展示后端 { detail }（client 已 sanitize）。 */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="flex items-start gap-2 rounded-lg border-l-2 border-danger bg-danger/5 px-3 py-2.5 text-[12px] text-danger">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{message}</span>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
                >
                    重试
                </button>
            )}
        </div>
    );
}

/** 居中加载态。 */
export function LoadingBlock({ label = "加载中…" }: { label?: string }) {
    return (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" />
            {label}
        </div>
    );
}

/** 空态：图标 + 标题 + 说明 + 可选操作。 */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
}: {
    icon: LucideIcon;
    title: string;
    description?: string;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-border-subtle text-tertiary">
                <Icon className="h-5 w-5" />
            </div>
            <p className="mt-3 text-[14px] font-medium text-foreground">{title}</p>
            {description && <p className="mt-1 max-w-[360px] text-[12px] leading-relaxed text-secondary">{description}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

/** 浅色卡片容器。 */
export function SurfaceCard({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={cn("rounded-xl border border-border-subtle bg-surface p-4", className)}>{children}</div>
    );
}

/** 弹窗：portal + 淡入淡出；body 在 open 时才挂载以重置表单状态。 */
export function Modal({
    open,
    title,
    icon: Icon,
    onClose,
    children,
    width = "max-w-[480px]",
    footer,
}: {
    open: boolean;
    title: string;
    icon?: LucideIcon;
    onClose: () => void;
    children: ReactNode;
    width?: string;
    footer?: ReactNode;
}) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (typeof document === "undefined") return null;

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                >
                    <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className={cn(
                            "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]",
                            width,
                        )}
                        role="dialog"
                        aria-modal="true"
                        aria-label={title}
                    >
                        <div className="flex items-center gap-2.5 border-b border-border-subtle px-6 py-4">
                            {Icon && (
                                <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
                                    <Icon className="h-4 w-4" />
                                </div>
                            )}
                            <h2 className="flex-1 text-[16px] font-semibold tracking-tight text-foreground">{title}</h2>
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="关闭"
                                className="grid h-7 w-7 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
                        {footer && <div className="border-t border-border-subtle px-6 py-3">{footer}</div>}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}
