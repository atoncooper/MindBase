"use client";

/**
 * 写作 Tab —— 章节编辑器 + 写作文件中心。
 *
 * 上半部分「章节编辑」：选择项目写作文档 → 选择章节 → 编辑正文并保存
 * （GET /academic/projects/:projectId/documents、GET /academic/documents/:id、
 * POST /academic/documents/:id/sections），并为当前文档提供「下载投稿包」
 * （GET /academic/documents/:id/package，后端先校验稿件与投稿审批）。
 * 下半部分保留写作文件中心：点击文件在新标签页查看（Word/PDF/图片/文本预览），
 * 可下载继续改；文件来自项目学术空间 05_论文 目录与写作文档来源/回存。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Download,
    FileImage,
    FilePenLine,
    FilePlus2,
    FileText,
    Loader2,
    PackageOpen,
    Plus,
    RefreshCw,
    Save,
    Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    academicApi,
    cloudApi,
    type AcademicDocument,
    type AcademicDocumentSummary,
    type AcademicProjectFile,
    type AcademicProjectFiles,
    type AcademicSection,
} from "@/lib/api";
import {
    DOC_KIND_LABELS,
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    SurfaceCard,
    formatDateTime,
} from "./research-ui";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 单章节正文上限（与后端 academic.MAX_TEXT 一致）。 */
const SECTION_CONTENT_LIMIT = 200_000;

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

/** 投稿包下载文件名：去掉文件系统非法字符。 */
function packageFileName(title: string): string {
    const safe = title
        .replace(/[\\/:*?"<>|\s]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    return (safe || "投稿包") + "-投稿包.zip";
}

export function WritingTab({ projectId }: { projectId: string }) {
    // ---- 写作文档 / 章节编辑 ----
    const [documents, setDocuments] = useState<AcademicDocumentSummary[]>([]);
    const [documentsLoading, setDocumentsLoading] = useState(true);
    const [documentsError, setDocumentsError] = useState<string | null>(null);
    const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
    const [activeDoc, setActiveDoc] = useState<AcademicDocument | null>(null);
    const [activeDocLoading, setActiveDocLoading] = useState(false);
    const [activeDocError, setActiveDocError] = useState<string | null>(null);
    // 重试当前文档加载（递增触发 effect）。
    const [docReloadToken, setDocReloadToken] = useState(0);
    const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);
    const [packageBusy, setPackageBusy] = useState(false);
    const [packageError, setPackageError] = useState<string | null>(null);
    const [packageNotice, setPackageNotice] = useState<string | null>(null);

    // ---- 写作文件中心 ----
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

    const loadDocuments = useCallback(
        async (silent = false) => {
            if (!silent) setDocumentsLoading(true);
            setDocumentsError(null);
            try {
                const result = await academicApi.listDocuments(projectId);
                setDocuments(result.documents);
                setActiveDocumentId((current) =>
                    current && result.documents.some((doc) => doc.id === current)
                        ? current
                        : (result.documents[0]?.id ?? null),
                );
            } catch (e) {
                if (!silent) {
                    setDocumentsError(e instanceof Error ? e.message : "加载写作文档失败");
                }
            } finally {
                if (!silent) setDocumentsLoading(false);
            }
        },
        [projectId],
    );

    useEffect(() => {
        // 异步 IIFE 包一层：effect 体内不同步调用会 setState 的函数（react-hooks 规则）。
        void (async () => {
            await load();
        })();
    }, [load]);

    useEffect(() => {
        // 切换项目：清空当前文档/章节选择后再拉取文档列表。
        void (async () => {
            setActiveDocumentId(null);
            setActiveDoc(null);
            setActiveSectionKey(null);
            setDraft("");
            setSaveError(null);
            setSaveNotice(null);
            setPackageError(null);
            setPackageNotice(null);
            setDocumentsLoading(true);
            await loadDocuments();
        })();
    }, [loadDocuments]);

    useEffect(() => {
        if (!activeDocumentId) return;
        let active = true;
        void (async () => {
            setActiveDocLoading(true);
            setActiveDoc(null);
            setActiveDocError(null);
            setActiveSectionKey(null);
            setDraft("");
            try {
                const result = await academicApi.getDocument(activeDocumentId);
                if (!active) return;
                setActiveDoc(result.document);
                const first = result.document.sections[0];
                setActiveSectionKey(first?.key ?? null);
                setDraft(first?.content ?? "");
            } catch (e) {
                if (active) {
                    setActiveDocError(e instanceof Error ? e.message : "加载文档章节失败");
                }
            } finally {
                if (active) setActiveDocLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [activeDocumentId, docReloadToken]);

    const files = useMemo(() => (data?.files ?? []).filter(isWritingFile), [data]);

    const activeSection =
        activeDoc?.sections.find((section) => section.key === activeSectionKey) ?? null;
    const dirty = activeSection !== null && draft !== activeSection.content;
    const overLimit = draft.length > SECTION_CONTENT_LIMIT;

    function selectDocument(documentId: string) {
        if (documentId === activeDocumentId) return;
        setActiveDocumentId(documentId);
        setSaveError(null);
        setSaveNotice(null);
        setPackageError(null);
        setPackageNotice(null);
    }

    function selectSection(section: AcademicSection) {
        setActiveSectionKey(section.key);
        setDraft(section.content);
        setSaveError(null);
        setSaveNotice(null);
    }

    async function saveSection() {
        if (!activeDoc || !activeSection || saving) return;
        if (overLimit) {
            setSaveError(
                "正文超过 " + SECTION_CONTENT_LIMIT.toLocaleString() + " 字符上限，请删减后再保存。",
            );
            return;
        }
        setSaving(true);
        setSaveError(null);
        setSaveNotice(null);
        try {
            const result = await academicApi.saveSection(activeDoc.id, {
                key: activeSection.key,
                title: activeSection.title,
                content: draft,
            });
            setActiveDoc(result.document);
            setSaveNotice("章节已保存");
            void loadDocuments(true);
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : "保存章节失败");
        } finally {
            setSaving(false);
        }
    }

    async function downloadPackage() {
        if (!activeDoc || packageBusy) return;
        setPackageBusy(true);
        setPackageError(null);
        setPackageNotice(null);
        try {
            const blob = await academicApi.downloadSubmissionPackage(activeDoc.id);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = packageFileName(activeDoc.title);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            setPackageNotice("投稿包已开始下载");
        } catch (e) {
            setPackageError(e instanceof Error ? e.message : "下载投稿包失败");
        } finally {
            setPackageBusy(false);
        }
    }

    async function handleImport(file: File) {
        if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) {
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
            const result = await academicApi.importDocumentDocx(projectId, file);
            await load();
            await loadDocuments(true);
            setActiveDocumentId(result.document.id);
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
            await load();
            await loadDocuments(true);
            setActiveDocumentId(result.document.id);
            setNotice("已作为模板导入：" + result.document.title + "，可在对话中让 agent 完善");
        } catch (e) {
            setNotice(e instanceof Error ? e.message : "作为论文模板导入失败");
        } finally {
            setTemplateBusyUuid(null);
        }
    }

    return (
        <div className="space-y-4">
            <SurfaceCard className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                    <div className="min-w-0">
                        <h3 className="text-[14px] font-semibold text-foreground">章节编辑</h3>
                        <p className="mt-0.5 text-[11px] text-tertiary">
                            选择写作文档与章节直接编辑正文并保存；单节正文上限 200,000 字符。
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <button
                            type="button"
                            disabled={!activeDoc || packageBusy}
                            onClick={() => void downloadPackage()}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                            title={
                                activeDoc
                                    ? "下载《" + activeDoc.title + "》投稿包（zip）"
                                    : "先选择写作文档"
                            }
                        >
                            {packageBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <PackageOpen className="h-3.5 w-3.5" />
                            )}
                            下载投稿包
                        </button>
                        <button
                            type="button"
                            onClick={() => void loadDocuments()}
                            disabled={documentsLoading}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                        >
                            <RefreshCw
                                className={cn("h-3.5 w-3.5", documentsLoading && "animate-spin")}
                            />
                            刷新文档
                        </button>
                    </div>
                </div>

                {saveNotice && (
                    <div className="border-b border-border-subtle bg-border-subtle/40 px-4 py-2 text-[12px] text-secondary">
                        {saveNotice}
                    </div>
                )}
                {packageNotice && (
                    <div className="border-b border-border-subtle bg-border-subtle/40 px-4 py-2 text-[12px] text-secondary">
                        {packageNotice}
                    </div>
                )}
                {packageError && (
                    <div className="border-b border-border-subtle px-4 py-2">
                        <ErrorBanner message={packageError} onRetry={() => void downloadPackage()} />
                    </div>
                )}

                {documentsError && (
                    <div className="border-b border-border-subtle px-4 py-2">
                        <ErrorBanner message={documentsError} onRetry={() => void loadDocuments()} />
                    </div>
                )}

                {documentsLoading && documents.length === 0 ? (
                    <LoadingBlock label="加载写作文档…" />
                ) : documents.length === 0 ? (
                    <div className="p-4">
                        <EmptyState
                            icon={FilePenLine}
                            title="还没有写作文档"
                            description="可在对话中让智能体创建开题报告/初稿，或在下方文件中心导入 Word 作为论文模板。"
                        />
                    </div>
                ) : (
                    <>
                        <div className="border-b border-border-subtle px-4 py-2.5">
                            <p className="text-[11px] font-medium text-tertiary">写作文档</p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {documents.map((doc) => (
                                    <button
                                        key={doc.id}
                                        type="button"
                                        disabled={saving}
                                        onClick={() => selectDocument(doc.id)}
                                        className={cn(
                                            "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-40",
                                            doc.id === activeDocumentId
                                                ? "bg-foreground text-surface"
                                                : "border border-border text-secondary hover:bg-border-subtle hover:text-foreground",
                                        )}
                                        title={doc.title}
                                    >
                                        <FileText className="h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate">{doc.title}</span>
                                        <span className="shrink-0 text-[10px] opacity-70">
                                            {DOC_KIND_LABELS[doc.kind]}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {activeDocLoading && !activeDoc ? (
                            <LoadingBlock label="加载文档章节…" />
                        ) : activeDocError ? (
                            <div className="p-4">
                                <ErrorBanner
                                    message={activeDocError}
                                    onRetry={() => setDocReloadToken((token) => token + 1)}
                                />
                            </div>
                        ) : !activeDoc ? (
                            <LoadingBlock label="加载文档章节…" />
                        ) : activeDoc.sections.length === 0 ? (
                            <div className="p-4">
                                <EmptyState
                                    icon={FileText}
                                    title="该文档还没有章节"
                                    description="可让智能体在对话中写入章节，或切换其他写作文档。"
                                />
                            </div>
                        ) : (
                            <div className="grid md:grid-cols-[200px_minmax(0,1fr)]">
                                <div className="border-b border-border-subtle px-3 py-3 md:border-r md:border-b-0">
                                    <p className="px-1 text-[11px] font-medium text-tertiary">章节</p>
                                    <ul className="mt-1 space-y-0.5">
                                        {activeDoc.sections.map((section) => (
                                            <li key={section.key}>
                                                <button
                                                    type="button"
                                                    disabled={saving}
                                                    onClick={() => selectSection(section)}
                                                    className={cn(
                                                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors disabled:opacity-40",
                                                        section.key === activeSectionKey
                                                            ? "bg-accent-soft font-medium text-accent"
                                                            : "text-secondary hover:bg-border-subtle hover:text-foreground",
                                                    )}
                                                    title={section.title}
                                                >
                                                    <span className="truncate">{section.title}</span>
                                                    <span className="shrink-0 text-[10px] text-tertiary">
                                                        {section.content.length}
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                <div className="flex min-w-0 flex-col px-4 py-3">
                                    {activeSection ? (
                                        <>
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <h4 className="text-[13px] font-medium text-foreground">
                                                    {activeSection.title}
                                                </h4>
                                                <span
                                                    className={cn(
                                                        "text-[11px]",
                                                        dirty ? "text-warning" : "text-tertiary",
                                                    )}
                                                >
                                                    {dirty ? "有未保存修改" : "已保存"}
                                                </span>
                                            </div>
                                            <textarea
                                                value={draft}
                                                onChange={(e) => {
                                                    setDraft(e.target.value);
                                                    setSaveNotice(null);
                                                }}
                                                disabled={saving}
                                                spellCheck={false}
                                                placeholder="在此编辑章节正文…"
                                                className="mt-2 min-h-[320px] w-full flex-1 resize-y rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors focus:border-accent disabled:opacity-60"
                                            />
                                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                                <span
                                                    className={cn(
                                                        "text-[11px]",
                                                        overLimit ? "text-danger" : "text-tertiary",
                                                    )}
                                                >
                                                    {draft.length.toLocaleString()} /{" "}
                                                    {SECTION_CONTENT_LIMIT.toLocaleString()} 字符
                                                    {overLimit
                                                        ? " · 超出上限，请删减后再保存"
                                                        : ""}
                                                </span>
                                                <button
                                                    type="button"
                                                    disabled={saving || overLimit || !dirty}
                                                    onClick={() => void saveSection()}
                                                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                                                >
                                                    {saving ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        <Save className="h-3.5 w-3.5" />
                                                    )}
                                                    {saving ? "保存中…" : "保存章节"}
                                                </button>
                                            </div>
                                            {saveError && (
                                                <div className="mt-2">
                                                    <ErrorBanner message={saveError} />
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-[12px] text-tertiary">
                                            从左侧选择一个章节开始编辑。
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </SurfaceCard>

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
                            {importing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Upload className="h-3.5 w-3.5" />
                            )}
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
                            {creatingSpace ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Plus className="h-3.5 w-3.5" />
                            )}
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
                                <li
                                    key={(file.origin ?? "") + file.uploadUuid}
                                    className="flex items-center gap-3 px-4 py-3"
                                >
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
                                                {file.createdAt
                                                    ? " · " + formatDateTime(file.createdAt)
                                                    : ""}
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
        </div>
    );
}
