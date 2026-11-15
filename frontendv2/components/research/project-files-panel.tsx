"use client";

/**
 * 项目文件面板（Google / Material 3 外观，MUI 重做；数据与交互逻辑不变）。
 *
 * 数据来自 GET /academic/projects/:projectId/files：学术空间 7 个目录的文件 +
 * 写作文档的原始上传稿/回存稿（origin=document-*）。按目录或来源分组，点击文件
 * 打开预览弹层：
 *  - 文本类 / Word/Office 文档 -> cloudApi.getDocumentPreview 提取文本（可加载更多）
 *  - 图片 -> cloudApi.getRawFile 的 presigned URL 渲染图片
 *  - PDF -> presigned URL 用 iframe / 新窗口打开
 *  - 其他或提取失败 -> 元信息 + 下载
 * 弹层底部与每行都可「下载原文件」。组件禁止直接 fetch（统一走 cloudApi / academicApi）。
 *
 * readOnly=true 时供云盘「科研项目文件」入口复用：隐藏「创建学术空间」等写操作，
 * 保留刷新/预览/下载，空态文案改为只读说明（默认 false，科研工作台内行为不变）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
    Download,
    FileCode2,
    FileImage,
    FileText,
    FolderTree,
    Plus,
    RefreshCw,
    X,
    type LucideIcon,
} from "lucide-react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardHeader from "@mui/material/CardHeader";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
    academicApi,
    cloudApi,
    type AcademicProjectFile,
    type AcademicProjectFileOrigin,
    type AcademicProjectFiles,
} from "@/lib/api";
/** 预览形态：文本提取 / 图片 / PDF / 仅元信息。 */
type PreviewKind = "text" | "image" | "pdf" | "meta";

/** 文本预览每页字符数（app-cloud /preview 的 limit）。 */
const PREVIEW_LIMIT = 5000;

const TEXT_EXTENSIONS = [
    "md",
    "markdown",
    "txt",
    "tex",
    "latex",
    "json",
    "csv",
    "log",
    "yaml",
    "yml",
    "py",
    "js",
    "ts",
    "tsx",
    "html",
    "xml",
    "bib",
    "r",
    "c",
    "cpp",
    "java",
    "go",
    "sql",
];

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const ORIGIN_LABELS: Record<AcademicProjectFileOrigin, string> = {
    workspace: "学术空间目录",
    "document-source": "写作文档 · 原始上传稿",
    "document-export": "写作文档 · 回存稿",
};

/** 行内来源 Chip 的短文案（完整来源在元信息与分组标题里）。 */
const ORIGIN_SHORT_LABELS: Record<AcademicProjectFileOrigin, string> = {
    workspace: "空间目录",
    "document-source": "上传稿",
    "document-export": "回存稿",
};

function extensionOf(name: string): string {
    const lower = name.toLowerCase();
    const index = lower.lastIndexOf(".");
    return index >= 0 ? lower.slice(index + 1) : "";
}

/** 提取扩展名 / MIME 判断预览形态。 */
function classifyPreview(file: AcademicProjectFile): PreviewKind {
    const mime = (file.mimeType || "").toLowerCase();
    const ext = extensionOf(file.name);
    if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "image";
    if (mime === "application/pdf" || ext === "pdf") return "pdf";
    if (
        mime.startsWith("text/") ||
        TEXT_EXTENSIONS.includes(ext) ||
        ext === "docx" ||
        mime === DOCX_MIME ||
        mime === "application/msword" ||
        mime.includes("officedocument")
    ) {
        return "text";
    }
    return "meta";
}

function fileIcon(file: AcademicProjectFile): LucideIcon {
    const mime = (file.mimeType || "").toLowerCase();
    const ext = extensionOf(file.name);
    if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return FileImage;
    if (
        TEXT_EXTENSIONS.includes(ext) &&
        ["json", "csv", "log", "py", "js", "ts", "tsx", "html", "xml", "yaml", "yml", "r", "c", "cpp", "java", "go", "sql"].includes(ext)
    ) {
        return FileCode2;
    }
    return FileText;
}

/** 文件大小（元数据展示）。 */
function formatBytes(bytes?: number): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** app-cloud 的 createdAt 可能是毫秒或秒级时间戳，统一按毫秒渲染（YYYY-MM-DD HH:mm）。 */
function formatFileTime(value?: number): string {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
    const date = new Date(value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return "—";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface FileGroup {
    key: string;
    label: string;
    files: AcademicProjectFile[];
}

/** 分组标识：workspace 按目录 kind，文档条目按来源单独成组。 */
function groupIdentity(file: AcademicProjectFile): { key: string; label: string } {
    if (file.origin === "document-source") {
        return { key: "document-source", label: "写作文档 · 原始上传稿" };
    }
    if (file.origin === "document-export") {
        return { key: "document-export", label: "写作文档 · 回存稿" };
    }
    const kind = file.folderKind || "other";
    return { key: `workspace:${kind}`, label: file.folderLabel || kind };
}

/** 按后端返回顺序分组（目录顺序 -> 目录内时间倒序 -> 文档条目）。 */
function groupFiles(files: AcademicProjectFile[]): FileGroup[] {
    const groups = new Map<string, FileGroup>();
    for (const file of files) {
        const { key, label } = groupIdentity(file);
        const group = groups.get(key);
        if (group) {
            group.files.push(file);
        } else {
            groups.set(key, { key, label, files: [file] });
        }
    }
    return [...groups.values()];
}

/** 文件元信息表（无法内嵌预览时展示）。 */
function FileMeta({ file }: { file: AcademicProjectFile }) {
    const rows: { label: string; value: string }[] = [
        { label: "名称", value: file.name || file.uploadUuid },
        { label: "大小", value: formatBytes(file.size) },
        { label: "时间", value: formatFileTime(file.createdAt) },
        { label: "类型", value: file.mimeType || "未知" },
        { label: "来源", value: ORIGIN_LABELS[file.origin] },
    ];
    if (file.folderLabel) rows.push({ label: "目录", value: file.folderLabel });
    if (file.documentTitle) rows.push({ label: "文档", value: file.documentTitle });
    return (
        <Box
            component="dl"
            sx={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr)",
                gap: "8px 16px",
                m: 0,
                p: 2,
                bgcolor: "#f8f9fa",
                border: 1,
                borderColor: "divider",
                borderRadius: "8px",
            }}
        >
            {rows.map((row) => (
                <Fragment key={row.label}>
                    <Typography component="dt" variant="caption" sx={{ color: "text.secondary" }}>
                        {row.label}
                    </Typography>
                    <Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: "break-all" }}>
                        {row.value}
                    </Typography>
                </Fragment>
            ))}
        </Box>
    );
}

/** Google 风格空态：圆形浅灰图标块 + 标题 + 说明。 */
function GoogleEmptyState({
    icon: Icon,
    title,
    description,
}: {
    icon: LucideIcon;
    title: string;
    description: string;
}) {
    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                px: 3,
                py: 6,
            }}
        >
            <Avatar sx={{ width: 56, height: 56, bgcolor: "#f1f3f4", color: "#5f6368" }}>
                <Icon size={26} />
            </Avatar>
            <Typography variant="h3" component="p" sx={{ mt: 2 }}>
                {title}
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5, maxWidth: 380, color: "text.secondary" }}>
                {description}
            </Typography>
        </Box>
    );
}

export function ProjectFilesPanel({
    projectId,
    filter,
    title = "项目文件",
    onChanged,
    readOnly = false,
}: {
    projectId: string;
    /** 只保留 05_论文 目录与写作文档来源/回存条目。 */
    filter?: "manuscript";
    title?: string;
    onChanged?: () => void | Promise<void>;
    /** 只读模式（云盘「科研项目文件」入口）：隐藏创建学术空间等写操作。 */
    readOnly?: boolean;
}) {
    const [data, setData] = useState<AcademicProjectFiles | null>(null);
    // loadedProjectId 用于派生 loading：避免在 effect 体内同步 setState（react-hooks 规则）。
    const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [downloadingUuid, setDownloadingUuid] = useState<string | null>(null);

    // 预览弹层
    const [previewFile, setPreviewFile] = useState<AcademicProjectFile | null>(null);
    const [previewKind, setPreviewKind] = useState<PreviewKind>("text");
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [previewText, setPreviewText] = useState("");
    const [previewTotalChars, setPreviewTotalChars] = useState(0);
    const [previewNextOffset, setPreviewNextOffset] = useState<number | null>(null);
    const [previewRawUrl, setPreviewRawUrl] = useState<string | null>(null);
    const [previewLoadingMore, setPreviewLoadingMore] = useState(false);

    // 快速切换项目/预览文件时只接受最后一次请求的响应。
    const loadSeq = useRef(0);
    const previewSeq = useRef(0);
    const loading = loadedProjectId !== projectId;

    const load = useCallback(async () => {
        const seq = loadSeq.current + 1;
        loadSeq.current = seq;
        try {
            const result = await academicApi.listProjectFiles(projectId);
            if (loadSeq.current !== seq) return;
            setData(result);
            setError(null);
        } catch (e) {
            if (loadSeq.current !== seq) return;
            setError(e instanceof Error ? e.message : "加载项目文件失败");
        } finally {
            if (loadSeq.current === seq) {
                // 标记该项目的首轮加载结束（错误也算结束，错误条单独展示）。
                setLoadedProjectId(projectId);
                setRefreshing(false);
            }
        }
    }, [projectId]);

    useEffect(() => {
        // 异步 IIFE 包一层：effect 体内不同步调用会 setState 的函数（react-hooks 规则）。
        void (async () => {
            await load();
        })();
    }, [load]);

    function retry() {
        setError(null);
        setLoadedProjectId(null);
        void load();
    }

    async function createWorkspace() {
        setCreating(true);
        setError(null);
        try {
            await academicApi.ensureWorkspace(projectId);
            setLoadedProjectId(null);
            await load();
            await onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建学术空间失败");
        } finally {
            setCreating(false);
        }
    }

    /** 用 presigned URL 打开/下载原文件（不经过 fetch）。 */
    async function openRaw(file: AcademicProjectFile) {
        setDownloadingUuid(file.uploadUuid);
        setActionError(null);
        try {
            const raw = await cloudApi.getRawFile(file.uploadUuid);
            if (!raw.url) {
                setActionError("未获取到文件下载链接，请稍后重试");
                return;
            }
            window.open(raw.url, "_blank", "noopener,noreferrer");
        } catch (e) {
            setActionError(e instanceof Error ? e.message : "获取文件下载链接失败");
        } finally {
            setDownloadingUuid(null);
        }
    }

    function closePreview() {
        previewSeq.current += 1;
        setPreviewFile(null);
        setPreviewError(null);
        setActionError(null);
        setPreviewText("");
        setPreviewRawUrl(null);
        setPreviewNextOffset(null);
    }

    async function openPreview(file: AcademicProjectFile) {
        const seq = previewSeq.current + 1;
        previewSeq.current = seq;
        const kind = classifyPreview(file);
        setPreviewFile(file);
        setPreviewKind(kind);
        setPreviewError(null);
        setActionError(null);
        setPreviewText("");
        setPreviewTotalChars(0);
        setPreviewNextOffset(null);
        setPreviewRawUrl(null);
        if (kind === "meta") {
            setPreviewLoading(false);
            return;
        }
        setPreviewLoading(true);
        try {
            if (kind === "text") {
                const page = await cloudApi.getDocumentPreview(file.uploadUuid, 0, PREVIEW_LIMIT);
                if (previewSeq.current !== seq) return;
                setPreviewText(page.preview ?? "");
                setPreviewTotalChars(page.totalChars ?? 0);
                setPreviewNextOffset(page.hasMore ? page.nextOffset ?? null : null);
            } else {
                const raw = await cloudApi.getRawFile(file.uploadUuid);
                if (previewSeq.current !== seq) return;
                if (!raw.url) throw new Error("未获取到文件预览链接");
                setPreviewRawUrl(raw.url);
            }
        } catch (e) {
            if (previewSeq.current === seq) {
                setPreviewError(e instanceof Error ? e.message : "预览加载失败，可下载原文件查看");
            }
        } finally {
            if (previewSeq.current === seq) setPreviewLoading(false);
        }
    }

    async function loadMorePreview() {
        if (!previewFile || previewNextOffset === null || previewLoadingMore) return;
        setPreviewLoadingMore(true);
        setActionError(null);
        try {
            const page = await cloudApi.getDocumentPreview(
                previewFile.uploadUuid,
                previewNextOffset,
                PREVIEW_LIMIT,
            );
            setPreviewText((prev) => prev + (page.preview ?? ""));
            setPreviewTotalChars(page.totalChars ?? 0);
            setPreviewNextOffset(page.hasMore ? page.nextOffset ?? null : null);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : "加载更多失败");
        } finally {
            setPreviewLoadingMore(false);
        }
    }

    const allFiles = data?.files ?? [];
    const files =
        filter === "manuscript"
            ? allFiles.filter(
                  (file) =>
                      file.folderKind === "manuscript" ||
                      file.origin === "document-source" ||
                      file.origin === "document-export",
              )
            : allFiles;
    const groups = groupFiles(files);
    const workspaceMissing = !loading && data !== null && !data.workspace.exists;

    return (
        <Card variant="outlined" sx={{ borderRadius: "8px", overflow: "hidden" }}>
            <CardHeader
                avatar={
                    <Avatar
                        variant="rounded"
                        sx={{
                            width: 36,
                            height: 36,
                            borderRadius: "8px",
                            bgcolor: "primary.main",
                            color: "primary.contrastText",
                        }}
                    >
                        <FolderTree size={18} strokeWidth={2} />
                    </Avatar>
                }
                title={
                    <Typography variant="h3" component="h3" noWrap sx={{ color: "text.primary" }}>
                        {title}
                    </Typography>
                }
                action={
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <Chip
                            size="small"
                            label={`${files.length} 个`}
                            sx={{ bgcolor: "#f1f3f4", color: "text.secondary" }}
                        />
                        <Tooltip title="刷新">
                            <span>
                                <IconButton
                                    size="small"
                                    aria-label="刷新项目文件"
                                    onClick={() => {
                                        setRefreshing(true);
                                        void load();
                                    }}
                                    disabled={loading || refreshing}
                                    sx={{ color: "text.secondary" }}
                                >
                                    {loading || refreshing ? (
                                        <CircularProgress size={16} />
                                    ) : (
                                        <RefreshCw size={16} />
                                    )}
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Stack>
                }
                sx={{
                    px: 2,
                    py: 1.5,
                    borderBottom: 1,
                    borderColor: "divider",
                    "& .MuiCardHeader-content": { minWidth: 0 },
                    "& .MuiCardHeader-action": { alignSelf: "center", m: 0 },
                }}
            />

            {(loading || refreshing) && <LinearProgress />}

            {error && (
                <Alert
                    severity="error"
                    sx={{ m: 2, borderRadius: "8px" }}
                    action={
                        <Button color="inherit" size="small" onClick={retry}>
                            重试
                        </Button>
                    }
                >
                    {error}
                </Alert>
            )}

            {actionError && (
                <Alert severity="warning" sx={{ m: 2, borderRadius: "8px" }}>
                    {actionError}
                </Alert>
            )}

            {workspaceMissing && (
                <Alert
                    severity={readOnly ? "info" : "warning"}
                    icon={<FolderTree size={18} />}
                    sx={{ m: 2, borderRadius: "8px", alignItems: "center" }}
                    action={
                        !readOnly ? (
                            <Button
                                size="small"
                                variant="contained"
                                onClick={() => void createWorkspace()}
                                disabled={creating}
                                startIcon={
                                    creating ? (
                                        <CircularProgress size={14} color="inherit" />
                                    ) : (
                                        <Plus size={16} />
                                    )
                                }
                                sx={{ whiteSpace: "nowrap" }}
                            >
                                创建学术空间
                            </Button>
                        ) : undefined
                    }
                >
                    {readOnly
                        ? "本项目还没有学术空间目录；学术空间由科研工作台创建，创建后 AI 生成的文件会归档到这里。"
                        : "本项目还没有学术空间目录（AI 生成文件会存到 05_论文/04_结果 等目录）"}
                </Alert>
            )}

            {loading ? (
                <Box sx={{ px: 2, py: 2 }}>
                    <Stack spacing={1}>
                        {[0, 1, 2, 3].map((row) => (
                            <Skeleton
                                key={row}
                                variant="rounded"
                                height={48}
                                sx={{ borderRadius: "8px" }}
                            />
                        ))}
                    </Stack>
                </Box>
            ) : !data ? null : files.length === 0 ? (
                <GoogleEmptyState
                    icon={FolderTree}
                    title={filter === "manuscript" ? "还没有论文相关文件" : "项目还没有文件"}
                    description={
                        readOnly
                            ? workspaceMissing
                                ? "学术空间由科研工作台创建；创建后，AI 生成的结果表、Word 稿与实验日志会归档到这里。"
                                : "这里只读展示科研工作台归档的项目文件；生成/回存请在科研工作台完成。"
                            : workspaceMissing
                              ? "创建学术空间后，AI 生成的结果表、Word 稿与实验日志会归档到这里。"
                              : "AI 生成的结果表、Word 稿、实验日志与写作文档的来源/回存文件会出现在这里。"
                    }
                />
            ) : (
                <List disablePadding>
                    {groups.map((group) => (
                        <Fragment key={group.key}>
                            <ListSubheader
                                disableSticky
                                sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 1,
                                    lineHeight: "32px",
                                    px: 2,
                                    bgcolor: "#f8f9fa",
                                    borderBottom: 1,
                                    borderColor: "divider",
                                }}
                            >
                                <Typography
                                    variant="caption"
                                    noWrap
                                    sx={{ fontWeight: 500, color: "text.secondary" }}
                                >
                                    {group.label}
                                </Typography>
                                <Typography variant="caption" sx={{ color: "text.disabled" }}>
                                    {`${group.files.length} 个`}
                                </Typography>
                            </ListSubheader>
                            {group.files.map((file) => {
                                const Icon = fileIcon(file);
                                const active = previewFile?.uploadUuid === file.uploadUuid;
                                const displayName = file.name || file.uploadUuid;
                                return (
                                    <ListItem
                                        key={`${file.origin}:${file.uploadUuid}`}
                                        disablePadding
                                        sx={{
                                            borderBottom: 1,
                                            borderColor: "divider",
                                            bgcolor: active ? "#e8f0fe" : "transparent",
                                            transition: "background-color 120ms",
                                            "&:hover": {
                                                bgcolor: active ? "#d2e3fc" : "#f1f3f4",
                                            },
                                        }}
                                    >
                                        <ListItemButton
                                            onClick={() => void openPreview(file)}
                                            title="点击预览"
                                            aria-current={active ? "true" : undefined}
                                            sx={{
                                                flex: 1,
                                                minWidth: 0,
                                                gap: 1.5,
                                                px: 2,
                                                py: 1,
                                                bgcolor: "transparent",
                                                "&:hover": { bgcolor: "transparent" },
                                            }}
                                        >
                                            <ListItemIcon sx={{ minWidth: 0 }}>
                                                <Avatar
                                                    variant="rounded"
                                                    sx={{
                                                        width: 36,
                                                        height: 36,
                                                        borderRadius: "8px",
                                                        bgcolor: active ? "#d2e3fc" : "#f1f3f4",
                                                        color: active ? "#174ea6" : "text.secondary",
                                                    }}
                                                >
                                                    <Icon size={17} strokeWidth={2} />
                                                </Avatar>
                                            </ListItemIcon>
                                            <ListItemText
                                                disableTypography
                                                sx={{ my: 0, minWidth: 0 }}
                                                primary={
                                                    <Typography
                                                        variant="body2"
                                                        noWrap
                                                        sx={{ fontWeight: 500, color: "text.primary" }}
                                                    >
                                                        {displayName}
                                                    </Typography>
                                                }
                                                secondary={
                                                    file.documentTitle ? (
                                                        <Typography
                                                            variant="caption"
                                                            noWrap
                                                            sx={{ display: "block", color: "text.secondary" }}
                                                        >
                                                            《{file.documentTitle}》
                                                        </Typography>
                                                    ) : undefined
                                                }
                                            />
                                            <Chip
                                                size="small"
                                                label={ORIGIN_SHORT_LABELS[file.origin]}
                                                sx={{
                                                    flexShrink: 0,
                                                    display: { xs: "none", sm: "inline-flex" },
                                                    bgcolor: active ? "rgba(26,115,232,0.12)" : "#f1f3f4",
                                                    color: active ? "#174ea6" : "text.secondary",
                                                    "& .MuiChip-label": { px: 1 },
                                                }}
                                            />
                                            <Typography
                                                variant="caption"
                                                sx={{
                                                    flexShrink: 0,
                                                    width: 64,
                                                    textAlign: "right",
                                                    color: "text.secondary",
                                                    fontVariantNumeric: "tabular-nums",
                                                }}
                                            >
                                                {formatBytes(file.size)}
                                            </Typography>
                                            <Typography
                                                variant="caption"
                                                sx={{
                                                    flexShrink: 0,
                                                    display: { xs: "none", md: "block" },
                                                    color: "text.disabled",
                                                    fontVariantNumeric: "tabular-nums",
                                                }}
                                            >
                                                {formatFileTime(file.createdAt)}
                                            </Typography>
                                        </ListItemButton>
                                        <Box sx={{ flexShrink: 0, pr: 1 }}>
                                            <Tooltip title="下载原文件">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        aria-label={`下载原文件 ${displayName}`}
                                                        onClick={() => void openRaw(file)}
                                                        disabled={downloadingUuid !== null}
                                                        sx={{ color: "text.secondary" }}
                                                    >
                                                        {downloadingUuid === file.uploadUuid ? (
                                                            <CircularProgress size={15} />
                                                        ) : (
                                                            <Download size={16} />
                                                        )}
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </Box>
                                    </ListItem>
                                );
                            })}
                        </Fragment>
                    ))}
                </List>
            )}

            <Dialog
                open={previewFile !== null}
                onClose={closePreview}
                maxWidth="md"
                fullWidth
                slotProps={{ paper: { sx: { borderRadius: "8px" } } }}
            >
                <DialogTitle
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.5,
                        pr: 2,
                        borderBottom: 1,
                        borderColor: "divider",
                    }}
                >
                    <Avatar
                        variant="rounded"
                        sx={{
                            width: 36,
                            height: 36,
                            borderRadius: "8px",
                            bgcolor: "primary.main",
                            color: "primary.contrastText",
                        }}
                    >
                        <FileText size={18} />
                    </Avatar>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="h3" component="h2" noWrap>
                            {previewFile?.name || "文件预览"}
                        </Typography>
                        {previewFile?.documentTitle && (
                            <Typography
                                variant="caption"
                                noWrap
                                sx={{ display: "block", color: "text.secondary" }}
                            >
                                《{previewFile.documentTitle}》
                            </Typography>
                        )}
                    </Box>
                    <IconButton
                        size="small"
                        aria-label="关闭预览"
                        onClick={closePreview}
                        sx={{ color: "text.secondary" }}
                    >
                        <X size={18} />
                    </IconButton>
                </DialogTitle>
                <DialogContent dividers sx={{ py: 2 }}>
                    {previewFile && (
                        <Stack spacing={2}>
                            {previewError && (
                                <Alert severity="error" sx={{ borderRadius: "8px" }}>
                                    {previewError}
                                </Alert>
                            )}
                            {actionError && (
                                <Alert severity="warning" sx={{ borderRadius: "8px" }}>
                                    {actionError}
                                </Alert>
                            )}
                            {previewLoading ? (
                                <Box>
                                    <LinearProgress />
                                    <Stack spacing={1} sx={{ mt: 2 }}>
                                        {[0, 1, 2, 3, 4].map((row) => (
                                            <Skeleton key={row} variant="text" height={22} />
                                        ))}
                                    </Stack>
                                </Box>
                            ) : (
                                <>
                                    {previewKind === "text" && !previewError && (
                                        <>
                                            <Box
                                                component="pre"
                                                sx={{
                                                    m: 0,
                                                    p: 2,
                                                    maxHeight: "55vh",
                                                    overflow: "auto",
                                                    bgcolor: "#f8f9fa",
                                                    border: 1,
                                                    borderColor: "divider",
                                                    borderRadius: "8px",
                                                    fontFamily:
                                                        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
                                                    fontSize: 12.5,
                                                    lineHeight: 1.6,
                                                    whiteSpace: "pre-wrap",
                                                    wordBreak: "break-word",
                                                    color: "text.primary",
                                                }}
                                            >
                                                {previewText || "（文档没有可提取的文本内容）"}
                                            </Box>
                                            <Stack
                                                direction="row"
                                                spacing={1}
                                                sx={{
                                                    flexWrap: "wrap",
                                                    alignItems: "center",
                                                    justifyContent: "space-between",
                                                }}
                                            >
                                                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                                                    已提取 {previewText.length}
                                                    {previewTotalChars > 0
                                                        ? ` / ${previewTotalChars}`
                                                        : ""}{" "}
                                                    字
                                                </Typography>
                                                {previewNextOffset !== null && (
                                                    <Button
                                                        size="small"
                                                        variant="outlined"
                                                        onClick={() => void loadMorePreview()}
                                                        disabled={previewLoadingMore}
                                                    >
                                                        {previewLoadingMore && (
                                                            <CircularProgress size={14} sx={{ mr: 1 }} />
                                                        )}
                                                        加载更多
                                                    </Button>
                                                )}
                                            </Stack>
                                        </>
                                    )}
                                    {previewKind === "image" && previewRawUrl && (
                                        <Box sx={{ display: "flex", justifyContent: "center" }}>
                                            <Box
                                                component="img"
                                                src={previewRawUrl}
                                                alt={previewFile.name}
                                                sx={{
                                                    maxHeight: "60vh",
                                                    maxWidth: "100%",
                                                    borderRadius: "8px",
                                                    border: 1,
                                                    borderColor: "divider",
                                                    objectFit: "contain",
                                                }}
                                            />
                                        </Box>
                                    )}
                                    {previewKind === "pdf" && previewRawUrl && (
                                        <Stack spacing={1}>
                                            <Box
                                                component="iframe"
                                                src={previewRawUrl}
                                                title={previewFile.name}
                                                sx={{
                                                    width: "100%",
                                                    height: "60vh",
                                                    border: 1,
                                                    borderColor: "divider",
                                                    borderRadius: "8px",
                                                }}
                                            />
                                            <Link
                                                href={previewRawUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                variant="caption"
                                                sx={{ fontWeight: 500 }}
                                            >
                                                新窗口打开
                                            </Link>
                                        </Stack>
                                    )}
                                    {(previewError || previewKind === "meta") && (
                                        <>
                                            <FileMeta file={previewFile} />
                                            <Typography variant="caption" sx={{ color: "text.secondary" }}>
                                                无法内嵌预览该文件（格式不支持或服务暂不可用），可下载原文件查看。
                                            </Typography>
                                        </>
                                    )}
                                </>
                            )}
                        </Stack>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, py: 1.5, gap: 1, justifyContent: "space-between" }}>
                    <Typography
                        variant="caption"
                        noWrap
                        sx={{ minWidth: 0, flex: 1, color: "text.secondary" }}
                    >
                        {previewFile?.name}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                        <Button
                            variant="outlined"
                            size="small"
                            onClick={() => {
                                if (previewFile) void openRaw(previewFile);
                            }}
                            disabled={downloadingUuid !== null}
                            startIcon={
                                downloadingUuid !== null ? (
                                    <CircularProgress size={14} />
                                ) : (
                                    <Download size={16} />
                                )
                            }
                        >
                            下载原文件
                        </Button>
                        <Button variant="contained" size="small" onClick={closePreview}>
                            关闭
                        </Button>
                    </Stack>
                </DialogActions>
            </Dialog>
        </Card>
    );
}