"use client";

/**
 * 项目文件面板：聚合展示一个科研项目在云盘/写作里的文件（契约 docs/project-files.md §2.2）。
 *
 * 数据来自 GET /academic/projects/:projectId/files：学术空间 7 个目录的文件 +
 * 写作文档的原始上传稿/回存稿（origin=document-*）。按目录或来源分组，点击文件
 * 打开预览弹层：
 *  - 文本类 / Word/Office 文档 -> cloudApi.getDocumentPreview 提取文本（可加载更多）
 *  - 图片 -> cloudApi.getRawFile 的 presigned URL 渲染 <img>
 *  - PDF -> presigned URL 用 <iframe> / 新窗口打开
 *  - 其他或提取失败 -> 元信息 + 下载
 * 弹层底部与每行都可「下载原文件」。组件禁止直接 fetch（统一走 cloudApi / academicApi）。
 *
 * readOnly=true 时供云盘「科研项目文件」入口复用：隐藏「创建学术空间」等写操作，
 * 保留刷新/预览/下载，空态文案改为只读说明（默认 false，科研工作台内行为不变）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Download,
    FileCode2,
    FileImage,
    FileText,
    FolderTree,
    Loader2,
    Plus,
    RefreshCw,
    type LucideIcon,
} from "lucide-react";
import {
    academicApi,
    cloudApi,
    type AcademicProjectFile,
    type AcademicProjectFileOrigin,
    type AcademicProjectFiles,
} from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    Modal,
    formatDateTime,
} from "./research-ui";

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

/** app-cloud 的 createdAt 可能是毫秒或秒级时间戳，统一按毫秒渲染。 */
function formatFileTime(value?: number): string {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
    return formatDateTime(value < 1e12 ? value * 1000 : value);
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border-subtle bg-border-subtle/20 p-3 text-[12px]">
            {rows.map((row) => (
                <div key={row.label} className="contents">
                    <dt className="text-tertiary">{row.label}</dt>
                    <dd className="min-w-0 break-all text-foreground">{row.value}</dd>
                </div>
            ))}
        </dl>
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
        <section className="rounded-xl border border-border-subtle bg-surface">
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                    <FolderTree className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                    <h3 className="truncate text-[13px] font-medium text-foreground">{title}</h3>
                    <span className="shrink-0 text-[11px] text-tertiary">{files.length} 个</span>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        setRefreshing(true);
                        void load();
                    }}
                    disabled={loading || refreshing}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                >
                    <RefreshCw className={`h-3 w-3 ${loading || refreshing ? "animate-spin" : ""}`} />
                    刷新
                </button>
            </div>

            {error && (
                <div className="px-4 pt-3">
                    <ErrorBanner message={error} onRetry={retry} />
                </div>
            )}

            {actionError && (
                <div className="px-4 pt-3">
                    <ErrorBanner message={actionError} />
                </div>
            )}

            {workspaceMissing && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-warning/5 px-4 py-2.5 text-[12px] text-warning">
                    <FolderTree className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                        {readOnly
                            ? "本项目还没有学术空间目录；学术空间由科研工作台创建，创建后 AI 生成的文件会归档到这里。"
                            : "本项目还没有学术空间目录（AI 生成文件会存到 05_论文/04_结果 等目录）"}
                    </span>
                    {!readOnly && (
                        <button
                            type="button"
                            onClick={() => void createWorkspace()}
                            disabled={creating}
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            {creating ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Plus className="h-3 w-3" />
                            )}
                            创建学术空间
                        </button>
                    )}
                </div>
            )}

            {loading ? (
                <LoadingBlock label="加载项目文件…" />
            ) : !data ? null : files.length === 0 ? (
                <EmptyState
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
                <div>
                    {groups.map((group) => (
                        <div key={group.key}>
                            <div className="flex items-center justify-between border-b border-border-subtle bg-border-subtle/30 px-4 py-1.5">
                                <span className="truncate text-[11px] font-medium text-secondary">
                                    {group.label}
                                </span>
                                <span className="shrink-0 text-[10px] text-tertiary">
                                    {group.files.length} 个
                                </span>
                            </div>
                            <ul className="divide-y divide-border-subtle">
                                {group.files.map((file) => {
                                    const Icon = fileIcon(file);
                                    const active = previewFile?.uploadUuid === file.uploadUuid;
                                    return (
                                        <li
                                            key={`${file.origin}:${file.uploadUuid}`}
                                            className="flex items-center gap-2 px-4 py-2"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => void openPreview(file)}
                                                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-border-subtle/50 ${
                                                    active ? "bg-accent-soft" : ""
                                                }`}
                                                title="点击预览"
                                            >
                                                <Icon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-[12px] text-foreground">
                                                        {file.name || file.uploadUuid}
                                                    </span>
                                                    {file.documentTitle && (
                                                        <span className="block truncate text-[10px] text-tertiary">
                                                            《{file.documentTitle}》
                                                        </span>
                                                    )}
                                                </span>
                                            </button>
                                            <span className="shrink-0 text-[11px] text-tertiary">
                                                {formatBytes(file.size)}
                                            </span>
                                            <span className="hidden shrink-0 text-[11px] text-tertiary sm:inline">
                                                {formatFileTime(file.createdAt)}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => void openRaw(file)}
                                                disabled={downloadingUuid !== null}
                                                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                                                title="下载原文件"
                                            >
                                                {downloadingUuid === file.uploadUuid ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <Download className="h-3 w-3" />
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            )}

            <Modal
                open={previewFile !== null}
                title={previewFile?.name || "文件预览"}
                icon={FileText}
                onClose={closePreview}
                width="max-w-[860px]"
                footer={
                    <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[11px] text-tertiary">
                            {previewFile?.name}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => {
                                    if (previewFile) void openRaw(previewFile);
                                }}
                                disabled={downloadingUuid !== null}
                                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                            >
                                {downloadingUuid !== null ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Download className="h-3 w-3" />
                                )}
                                下载原文件
                            </button>
                            <button
                                type="button"
                                onClick={closePreview}
                                className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                            >
                                关闭
                            </button>
                        </div>
                    </div>
                }
            >
                {previewFile && (
                    <div className="space-y-3">
                        {previewError && <ErrorBanner message={previewError} />}
                        {actionError && <ErrorBanner message={actionError} />}
                        {previewLoading ? (
                            <LoadingBlock label="加载预览…" />
                        ) : (
                            <>
                                {previewKind === "text" && !previewError && (
                                    <>
                                        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-border-subtle/20 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                                            {previewText || "（文档没有可提取的文本内容）"}
                                        </pre>
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-[11px] text-tertiary">
                                                已提取 {previewText.length}
                                                {previewTotalChars > 0
                                                    ? ` / ${previewTotalChars}`
                                                    : ""}{" "}
                                                字
                                            </span>
                                            {previewNextOffset !== null && (
                                                <button
                                                    type="button"
                                                    onClick={() => void loadMorePreview()}
                                                    disabled={previewLoadingMore}
                                                    className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                                                >
                                                    {previewLoadingMore && (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    )}
                                                    加载更多
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                                {previewKind === "image" && previewRawUrl && (
                                    <div className="flex justify-center">
                                        <img
                                            src={previewRawUrl}
                                            alt={previewFile.name}
                                            className="max-h-[60vh] max-w-full rounded-lg border border-border-subtle object-contain"
                                        />
                                    </div>
                                )}
                                {previewKind === "pdf" && previewRawUrl && (
                                    <div className="space-y-2">
                                        <iframe
                                            src={previewRawUrl}
                                            title={previewFile.name}
                                            className="h-[60vh] w-full rounded-lg border border-border-subtle"
                                        />
                                        <a
                                            href={previewRawUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent underline underline-offset-2 hover:no-underline"
                                        >
                                            新窗口打开
                                        </a>
                                    </div>
                                )}
                                {(previewError || previewKind === "meta") && (
                                    <>
                                        <FileMeta file={previewFile} />
                                        <p className="text-[11px] text-tertiary">
                                            无法内嵌预览该文件（格式不支持或服务暂不可用），可下载原文件查看。
                                        </p>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                )}
            </Modal>
        </section>
    );
}
