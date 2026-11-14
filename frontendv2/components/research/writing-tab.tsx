"use client";

/**
 * 写作 Tab —— 文件中心（2026-11-12 起）。
 *
 * 用户诉求：不要章节编辑器/Markdown 文本弹窗；写作页只展示“写作文件”列表，
 * 点击文件在**新标签页**打开（Word/PDF/图片/文本预览），可下载继续改。
 *
 * 文件来源：
 * - 项目学术空间 05_论文 目录（AI 回存的 Word、导入的原稿等）；
 * - 写作文档的 source（原始上传）/ lastExport（回存）条目。
 *
 * 数据来自 GET /academic/projects/:projectId/files（docs/project-files.md）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Download,
    FileImage,
    FilePlus2,
    FileText,
    Loader2,
    Plus,
    RefreshCw,
    Upload,
} from "lucide-react";
import {
    academicApi,
    cloudApi,
    type AcademicProjectFile,
    type AcademicProjectFiles,
} from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    SurfaceCard,
    formatDateTime,
} from "./research-ui";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Writer-view relevant files: 05_论文 目录 + 文档来源/回存。 */
function isWritingFile(file: AcademicProjectFile): boolean {
    if (file.origin === "document-source" || file.origin === "document-export") return true;
    return file.folderKind === "manuscript";
}

function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function fileIcon(file: AcademicProjectFile) {
    const mime = (file.mimeType || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    if (mime.startsWith("image/")) return FileImage;
    if (mime === "application/pdf" || name.endsWith(".pdf")) return FileText;
    if (mime.startsWith("text/") || /\.(md|txt|tex|log|json|csv)$/.test(name)) return FileText;
    return FileText;
}

/** 只有 .docx 支持「作为论文模板」导入为写作文档。 */
function isDocxFile(file: AcademicProjectFile): boolean {
    const mime = (file.mimeType || "").toLowerCase();
    return (file.name || "").toLowerCase().endsWith(".docx") || mime === DOCX_MIME;
}

function originLabel(file: AcademicProjectFile): string {
    if (file.origin === "document-source") return "原始上传稿";
    if (file.origin === "document-export") return "回存稿";
    return file.folderLabel ?? "项目文件";
}

function viewerHref(file: AcademicProjectFile): string {
    const params = new URLSearchParams();
    if (file.uploadUuid) params.set("uploadUuid", file.uploadUuid);
    if (file.name) params.set("name", file.name);
    if (file.mimeType) params.set("mime", file.mimeType);
    return "/research/file?" + params.toString();
}

export function WritingTab({ projectId }: { projectId: string }) {
    const [data, setData] = useState<AcademicProjectFiles | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    const [creatingSpace, setCreatingSpace] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    // 「作为论文模板」进行中的文件 uuid
    const [templateBusyUuid, setTemplateBusyUuid] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setData(await academicApi.listProjectFiles(projectId));
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载写作文件失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        // 异步 IIFE 包一层：effect 体内不同步调用会 setState 的函数（react-hooks 规则）。
        void (async () => {
            await load();
        })();
    }, [load]);

    const files = useMemo(
        () => (data?.files ?? []).filter(isWritingFile),
        [data],
    );

    async function handleImport(file: File) {
        if (!/\.docx$/i.test(file.name) && file.type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            setNotice("只支持 .docx 文件");
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            setNotice("文件超过 20MB 限制");
            return;
        }
        setImporting(true);
        setNotice(null);
        try {
            await academicApi.importDocumentDocx(projectId, file);
            await load();
            setNotice("已导入：" + file.name);
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "导入失败");
        } finally {
            setImporting(false);
        }
    }

    async function createSpace() {
        setCreatingSpace(true);
        setNotice(null);
        try {
            await academicApi.ensureWorkspace(projectId);
            await load();
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "创建学术空间失败");
        } finally {
            setCreatingSpace(false);
        }
    }

    async function download(file: AcademicProjectFile) {
        try {
            const raw = await cloudApi.getRawFile(file.uploadUuid);
            window.open(raw.url, "_blank", "noopener,noreferrer");
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "下载失败");
        }
    }

    /** 云盘 .docx → 写作文档（论文模板，不重复上传；来源文件作为后续导出模板）。 */
    async function importAsPaperTemplate(file: AcademicProjectFile) {
        setTemplateBusyUuid(file.uploadUuid);
        setNotice(null);
        try {
            const result = await academicApi.importDocumentFromCloud(projectId, {
                uploadUuid: file.uploadUuid,
            });
            setNotice(`已作为模板导入：${result.document.title}，可在对话中让 agent 完善`);
            await load();
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "作为论文模板导入失败");
        } finally {
            setTemplateBusyUuid(null);
        }
    }

    return (
        <SurfaceCard className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-foreground">写作文件</h3>
                    <p className="mt-0.5 text-[11px] text-tertiary">
                        点击文件在新标签页查看（Word / PDF / 文本），或下载继续编辑。
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <label
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
                    >
                        {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        导入 Word
                        <input
                            type="file"
                            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            className="hidden"
                            disabled={importing}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) void handleImport(file);
                            }}
                        />
                    </label>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        刷新
                    </button>
                </div>
            </div>

            {notice && (
                <div className="border-b border-border-subtle bg-border-subtle/40 px-4 py-2 text-[12px] text-secondary">
                    {notice}
                </div>
            )}
            {error && (
                <div className="p-4">
                    <ErrorBanner message={error} onRetry={() => void load()} />
                </div>
            )}

            {data && !data.workspace.exists && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-accent-soft/50 px-4 py-3 text-[12px]">
                    <span className="text-secondary">
                        本项目还没有学术空间目录；AI 生成/回存的 Word、结果表会存到 05_论文 / 04_结果 等目录。
                    </span>
                    <button
                        type="button"
                        onClick={() => void createSpace()}
                        disabled={creatingSpace}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                        {creatingSpace ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        创建学术空间
                    </button>
                </div>
            )}

            {loading ? (
                <LoadingBlock label="加载写作文件…" />
            ) : files.length === 0 ? (
                <div className="p-4">
                    <EmptyState
                        icon={FileText}
                        title="还没有写作文件"
                        description="导入已有 Word 稿，或让智能体在项目中生成/回存 Word、PDF 等文件后会出现在这里。"
                    />
                </div>
            ) : (
                <ul className="divide-y divide-border-subtle">
                    {files.map((file) => {
                        const Icon = fileIcon(file);
                        return (
                            <li key={(file.origin ?? "") + file.uploadUuid} className="flex items-center gap-3 px-4 py-3">
                                <a
                                    href={viewerHref(file)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group flex min-w-0 flex-1 items-center gap-3"
                                >
                                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-border-subtle/60 text-secondary">
                                        <Icon className="h-4 w-4" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                            <span className="truncate text-[13px] font-medium text-foreground group-hover:underline">
                                                {file.name || "未命名文件"}
                                            </span>
                                            <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                                {originLabel(file)}
                                            </span>
                                        </span>
                                        <span className="mt-0.5 block text-[11px] text-tertiary">
                                            {formatSize(file.size)}
                                            {file.createdAt ? " · " + formatDateTime(file.createdAt) : ""}
                                            {file.documentTitle ? " · " + file.documentTitle : ""}
                                        </span>
                                    </span>
                                </a>
                                {isDocxFile(file) && (
                                    <button
                                        type="button"
                                        onClick={() => void importAsPaperTemplate(file)}
                                        disabled={templateBusyUuid !== null}
                                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                                        title="导入为写作文档（论文模板），可在对话中让 agent 完善"
                                    >
                                        {templateBusyUuid === file.uploadUuid ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <FilePlus2 className="h-3 w-3" />
                                        )}
                                        作为论文模板
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => void download(file)}
                                    className="shrink-0 rounded-full p-1.5 text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                                    title="下载文件"
                                    aria-label="下载文件"
                                >
                                    <Download className="h-3.5 w-3.5" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </SurfaceCard>
    );
}
