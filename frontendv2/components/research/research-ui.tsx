"use client";

/**
 * 科研工作台共享 UI 片段：阶段/状态/类型的中文文案映射，以及卡片、徽标、
 * 错误条、空态、加载态和弹窗。
 *
 * 文案集中在此，避免各 Tab 各自维护一份中文标签而漂移。视觉改用 MUI
 * （@mui/material）+ GoogleResearchTheme 的 Google Workspace 风格：浅灰
 * #f8f9fa 背景、白色描边卡片、语义色 tonal chip / alert、pill 按钮。
 *
 * 这里只替换共享原语的实现，导出名 / Props / 行为保持不变，因此所有 Tab
 * （overview / literature / writing / experiments / evidence / validation /
 * analysis / workspace / plans / approvals / events）无需改动即可自动获得
 * Google 风格。调用方仍然会传旧的 Tailwind 语义色 className（如
 * "bg-success/10 text-success"），Pill 会识别其中的语义色并映射成 Google
 * tonal chip，避免个性化配色丢失。
 */
import { type ReactNode } from "react";
import {
    Alert,
    Box,
    Button,
    Card,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Stack,
    Typography,
    alpha,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { X, type LucideIcon } from "lucide-react";
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

/** 状态徽标配色（遗留 Tailwind 语义映射，保留导出以兼容旧引用）。 */
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

// ---- MUI / Google tonal chips ----------------------------------------------

type Tone = "neutral" | "muted" | "info" | "success" | "warning" | "error";

/** 从旧 Tailwind 语义色 className 推断 tonal chip 的语义（兼容各 Tab 的调用）。 */
function toneFromClassName(className?: string): Tone {
    if (!className) return "neutral";
    if (/\btext-success\b/.test(className)) return "success";
    if (/\btext-danger\b/.test(className)) return "error";
    if (/\btext-warning\b/.test(className)) return "warning";
    if (/\btext-accent\b/.test(className)) return "info";
    if (/\btext-(secondary|tertiary)\b/.test(className)) return "muted";
    return "neutral";
}

const CHIP_BASE_SX = {
    height: 20,
    borderRadius: "8px",
    fontSize: 11,
    fontWeight: 500,
    "& .MuiChip-label": {
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        px: 1,
        py: 0,
        lineHeight: 1.5,
    },
};

function toneSx(tone: Tone) {
    return (theme: Theme) => {
        switch (tone) {
            case "info":
                return {
                    bgcolor: alpha(theme.palette.primary.main, 0.1),
                    color: theme.palette.primary.dark,
                };
            case "success":
                return {
                    bgcolor: alpha(theme.palette.success.main, 0.12),
                    color: theme.palette.success.dark,
                };
            case "warning":
                return {
                    bgcolor: alpha(theme.palette.warning.main, 0.14),
                    color: theme.palette.warning.dark,
                };
            case "error":
                return {
                    bgcolor: alpha(theme.palette.error.main, 0.1),
                    color: theme.palette.error.dark,
                };
            case "muted":
                return { bgcolor: theme.palette.grey[100], color: theme.palette.text.secondary };
            default:
                return { bgcolor: theme.palette.grey[100], color: theme.palette.text.secondary };
        }
    };
}

const STAGE_STATUS_TONES: Record<AcademicStageStatus, Tone> = {
    locked: "neutral",
    active: "info",
    submitted: "warning",
    approved: "success",
    frozen: "muted",
};

/** 小号状态徽标。 */
export function StatusBadge({ status, className }: { status: AcademicStageStatus; className?: string }) {
    return (
        <Chip
            size="small"
            label={STAGE_STATUS_LABELS[status]}
            className={className}
            sx={[CHIP_BASE_SX, toneSx(STAGE_STATUS_TONES[status])]}
        />
    );
}

/** 通用浅色标签（类型、来源等）。 */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <Chip
            size="small"
            label={children}
            className={className}
            sx={[CHIP_BASE_SX, toneSx(toneFromClassName(className))]}
        />
    );
}

/** 内联错误条：统一展示后端 { detail }（client 已 sanitize）。 */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <Alert
            severity="error"
            sx={{
                alignItems: "center",
                borderRadius: "8px",
                py: 0.25,
                "& .MuiAlert-icon": { mr: 1, fontSize: 18 },
                "& .MuiAlert-message": {
                    minWidth: 0,
                    py: 0.5,
                    wordBreak: "break-word",
                    fontSize: 12,
                    lineHeight: 1.5,
                },
            }}
            action={
                onRetry ? (
                    <Button
                        color="inherit"
                        size="small"
                        onClick={onRetry}
                        sx={{ minWidth: 0, px: 1, fontSize: 12, fontWeight: 500 }}
                    >
                        重试
                    </Button>
                ) : undefined
            }
        >
            {message}
        </Alert>
    );
}

/** 居中加载态。 */
export function LoadingBlock({ label = "加载中…" }: { label?: string }) {
    return (
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", justifyContent: "center", py: 8 }}>
            <CircularProgress size={16} thickness={5} />
            <Typography variant="body2" color="text.secondary">
                {label}
            </Typography>
        </Stack>
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
        <Stack spacing={1.25} sx={{ alignItems: "center", justifyContent: "center", py: 8, textAlign: "center" }}>
            <Box
                sx={{
                    display: "grid",
                    placeItems: "center",
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    bgcolor: "grey.100",
                    color: "text.secondary",
                }}
            >
                <Icon size={22} aria-hidden="true" />
            </Box>
            <Typography variant="h3" sx={{ fontSize: 14, fontWeight: 500, color: "text.primary" }}>
                {title}
            </Typography>
            {description && (
                <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ maxWidth: 360, lineHeight: 1.6, px: 2 }}
                >
                    {description}
                </Typography>
            )}
            {action && <Box sx={{ pt: 1 }}>{action}</Box>}
        </Stack>
    );
}

/** 浅色卡片容器（MUI Card：白底 + #dadce0 描边 + 16px 圆角，由 theme 提供）。 */
export function SurfaceCard({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <Card variant="outlined" className={cn("p-4", className)} sx={{ boxShadow: "none" }}>
            {children}
        </Card>
    );
}

/** 弹窗默认宽度（沿用旧的 Tailwind max-w-[Npx] 契约）。 */
function dialogMaxWidth(width?: string): number {
    const match = width?.match(/(\d+)\s*px/);
    return match ? Number(match[1]) : 480;
}

/** 弹窗：MUI Dialog（Esc / 遮罩关闭由 MUI 处理）；body 在 open 时才挂载以重置表单状态。 */
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
    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth={false}
            aria-label={title}
            slotProps={{
                paper: {
                    sx: {
                        display: "flex",
                        flexDirection: "column",
                        width: "100%",
                        maxWidth: dialogMaxWidth(width),
                        maxHeight: "88vh",
                        m: 2,
                        borderRadius: "8px",
                    },
                },
            }}
        >
            <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5, pr: 1, py: 2 }}>
                {Icon && (
                    <Box
                        sx={{
                            display: "grid",
                            placeItems: "center",
                            width: 32,
                            height: 32,
                            flexShrink: 0,
                            borderRadius: "8px",
                            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                            color: "primary.main",
                        }}
                    >
                        <Icon size={16} aria-hidden="true" />
                    </Box>
                )}
                <Typography
                    variant="h2"
                    component="h2"
                    sx={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 500 }}
                >
                    {title}
                </Typography>
                <IconButton aria-label="关闭" size="small" onClick={onClose} sx={{ color: "text.secondary" }}>
                    <X size={18} aria-hidden="true" />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ px: 3, py: 2.5, overflowY: "auto" }}>{children}</DialogContent>
            {footer && <DialogActions sx={{ display: "block", px: 3, pb: 2.5, pt: 0 }}>{footer}</DialogActions>}
        </Dialog>
    );
}
