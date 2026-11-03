"use client";

/**
 * 写作 Tab：文档列表与新建、章节选择 / 正文编辑保存（按 key 或标题 upsert）、
 * 章节删除，以及 Markdown / LaTeX 导出（复制 / 下载）。
 *
 * 章节保存遵循后端契约：带 key 时按 key 命中；不带 key 时后端按标题派生并匹配，
 * 因此改标题后再保存可能生成新章节 —— 在编辑已有章节时始终带上原 key。
 */
import { useCallback, useEffect, useState } from "react";
import {
    Copy,
    Download,
    FilePlus2,
    FileText,
    Loader2,
    PenLine,
    Save,
    Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
    academicApi,
    type AcademicDocument,
    type AcademicDocumentKind,
    type AcademicDocumentSummary,
    type AcademicSection,
    type AcademicSectionInput,
} from "@/lib/api";
import {
    DOC_KIND_LABELS,
    DOC_KIND_ORDER,
    ErrorBanner,
    LoadingBlock,
    Modal,
    Pill,
    copyText,
    downloadText,
    formatDateTime,
} from "./research-ui";

type ExportFormat = "markdown" | "latex";

interface ExportResult {
    format: ExportFormat;
    title: string;
    text: string;
}

export function WritingTab({
    projectId,
    onChanged,
}: {
    projectId: string;
    onChanged: () => Promise<void>;
}) {
    const [documents, setDocuments] = useState<AcademicDocumentSummary[]>([]);
    const [docsLoading, setDocsLoading] = useState(true);
    const [docsError, setDocsError] = useState<string | null>(null);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

    const [document, setDocument] = useState<AcademicDocument | null>(null);
    const [docLoading, setDocLoading] = useState(false);
    const [docError, setDocError] = useState<string | null>(null);

    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [editorKey, setEditorKey] = useState<string | null>(null);
    const [editorTitle, setEditorTitle] = useState("");
    const [editorContent, setEditorContent] = useState("");

    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);

    // 新建文档
    const [creating, setCreating] = useState(false);
    const [newKind, setNewKind] = useState<AcademicDocumentKind>("draft");
    const [newTitle, setNewTitle] = useState("");

    // 删除章节 / 导出
    const [pendingDelete, setPendingDelete] = useState<AcademicSection | null>(null);
    const [exportResult, setExportResult] = useState<ExportResult | null>(null);

    const loadDocs = useCallback(
        async (selectId?: string) => {
            setDocsLoading(true);
            setDocsError(null);
            try {
                const result = await academicApi.listDocuments(projectId);
                setDocuments(result.documents);
                setSelectedDocId((current) => {
                    const wanted = selectId ?? current;
                    if (wanted && result.documents.some((doc) => doc.id === wanted)) return wanted;
                    return result.documents[0]?.id ?? null;
                });
            } catch (e) {
                setDocsError(e instanceof Error ? e.message : "加载文档列表失败");
            } finally {
                setDocsLoading(false);
            }
        },
        [projectId],
    );

    useEffect(() => {
        setSelectedDocId(null);
        setDocument(null);
        setSelectedKey(null);
        setEditorKey(null);
        setEditorTitle("");
        setEditorContent("");
        setNotice(null);
        setError(null);
        void loadDocs();
    }, [loadDocs]);

    const loadDocument = useCallback(async (documentId: string) => {
        setDocLoading(true);
        setDocError(null);
        try {
            const result = await academicApi.getDocument(documentId);
            setDocument(result.document);
            const first = result.document.sections[0];
            setSelectedKey(first?.key ?? null);
            setEditorKey(first?.key ?? null);
            setEditorTitle(first?.title ?? "");
            setEditorContent(first?.content ?? "");
        } catch (e) {
            setDocError(e instanceof Error ? e.message : "加载文档失败");
        } finally {
            setDocLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!selectedDocId) {
            setDocument(null);
            return;
        }
        void loadDocument(selectedDocId);
    }, [selectedDocId, loadDocument]);

    function flash(message: string) {
        setNotice(message);
    }

    function selectSection(section: AcademicSection) {
        setSelectedKey(section.key);
        setEditorKey(section.key);
        setEditorTitle(section.title);
        setEditorContent(section.content);
        setNotice(null);
        setError(null);
    }

    function startNewSection() {
        setSelectedKey(null);
        setEditorKey(null);
        setEditorTitle("");
        setEditorContent("");
        setNotice(null);
        setError(null);
    }

    async function saveSection() {
        if (!document || !editorTitle.trim()) return;
        setBusy("save");
        setError(null);
        try {
            const input: AcademicSectionInput = {
                title: editorTitle.trim(),
                content: editorContent,
            };
            if (editorKey) input.key = editorKey;
            const result = await academicApi.upsertSection(document.id, input);
            setDocument(result.document);
            // 定位刚保存的章节：有 key 按 key，无 key（新建）按标题回查后端派生的 key。
            const saved =
                result.document.sections.find((section) => section.key === editorKey) ??
                result.document.sections.find((section) => section.title === input.title);
            if (saved) {
                setSelectedKey(saved.key);
                setEditorKey(saved.key);
                setEditorTitle(saved.title);
                setEditorContent(saved.content);
            }
            flash(editorKey ? "章节已保存" : "章节已创建");
            await loadDocs(document.id);
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败");
        } finally {
            setBusy(null);
        }
    }

    async function removeSection(section: AcademicSection) {
        if (!document) return;
        setBusy("delete-section");
        setError(null);
        try {
            const result = await academicApi.deleteSection(document.id, section.key);
            setDocument(result.document);
            const first = result.document.sections[0];
            setSelectedKey(first?.key ?? null);
            setEditorKey(first?.key ?? null);
            setEditorTitle(first?.title ?? "");
            setEditorContent(first?.content ?? "");
            flash(`已删除章节「${section.title}」`);
            await loadDocs(document.id);
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除章节失败");
        } finally {
            setPendingDelete(null);
            setBusy(null);
        }
    }

    async function createDocument() {
        if (!newTitle.trim()) return;
        setBusy("create-doc");
        setError(null);
        try {
            const result = await academicApi.createDocument(projectId, {
                kind: newKind,
                title: newTitle.trim(),
            });
            setNewTitle("");
            setCreating(false);
            flash(`已创建写作文档《${result.document.title}》`);
            await loadDocs(result.document.id);
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "新建文档失败");
        } finally {
            setBusy(null);
        }
    }

    async function exportDocument(format: ExportFormat) {
        if (!document) return;
        setBusy(`export-${format}`);
        setError(null);
        try {
            const result = await academicApi.exportDocument(document.id, format);
            setExportResult({ format, title: result.title, text: result.text });
        } catch (e) {
            setError(e instanceof Error ? e.message : "导出失败");
        } finally {
            setBusy(null);
        }
    }

    async function copy(value: string, hint: string) {
        const ok = await copyText(value);
        setCopyHint(ok ? hint : "复制失败，请手动选中文本复制");
        window.setTimeout(() => setCopyHint(null), 2500);
    }

    const sections = document?.sections ?? [];

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            {notice && (
                <div className="flex items-center gap-2 rounded-lg border-l-2 border-success bg-success/5 px-3 py-2.5 text-[12px] text-success">
                    <Save className="h-3.5 w-3.5 shrink-0" />
                    {notice}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
                {/* 文档列表 */}
                <section className="rounded-xl border border-border-subtle bg-surface">
                    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2.5">
                        <h3 className="text-[13px] font-semibold text-foreground">写作文档</h3>
                        <button
                            type="button"
                            onClick={() => setCreating((open) => !open)}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle"
                        >
                            <FilePlus2 className="h-3 w-3" />
                            新建
                        </button>
                    </div>

                    {creating && (
                        <div className="space-y-2 border-b border-border-subtle bg-border-subtle/30 px-3 py-2.5">
                            <select
                                value={newKind}
                                onChange={(e) => setNewKind(e.target.value as AcademicDocumentKind)}
                                className="h-8 w-full rounded-lg border border-border bg-surface px-2 text-[12px] text-foreground outline-none"
                            >
                                {DOC_KIND_ORDER.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {DOC_KIND_LABELS[kind]}
                                    </option>
                                ))}
                            </select>
                            <input
                                value={newTitle}
                                onChange={(e) => setNewTitle(e.target.value)}
                                maxLength={200}
                                placeholder="文档标题"
                                className="field h-8 py-0 text-[12px]"
                            />
                            <button
                                type="button"
                                onClick={() => void createDocument()}
                                disabled={busy !== null || !newTitle.trim()}
                                className="inline-flex w-full items-center justify-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                            >
                                {busy === "create-doc" && <Loader2 className="h-3 w-3 animate-spin" />}
                                创建文档
                            </button>
                        </div>
                    )}

                    <div className="max-h-[520px] overflow-y-auto p-1.5">
                        {docsLoading ? (
                            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-tertiary">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                加载中…
                            </div>
                        ) : docsError ? (
                            <div className="p-2">
                                <ErrorBanner message={docsError} onRetry={() => void loadDocs()} />
                            </div>
                        ) : documents.length === 0 ? (
                            <div className="px-2 py-8 text-center">
                                <FileText className="mx-auto h-5 w-5 text-tertiary" />
                                <p className="mt-2 text-[12px] text-secondary">还没有写作文档</p>
                                <p className="mt-1 text-[11px] text-tertiary">点击「新建」创建开题报告/初稿等</p>
                            </div>
                        ) : (
                            <ul className="space-y-1">
                                {documents.map((doc) => {
                                    const active = doc.id === selectedDocId;
                                    return (
                                        <li key={doc.id}>
                                            <button
                                                type="button"
                                                onClick={() => setSelectedDocId(doc.id)}
                                                className={cn(
                                                    "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                                                    active ? "bg-accent-soft" : "hover:bg-border-subtle",
                                                )}
                                            >
                                                <div className="flex items-center gap-1.5">
                                                    <span
                                                        className={cn(
                                                            "min-w-0 flex-1 truncate text-[12px] font-medium",
                                                            active ? "text-accent" : "text-foreground",
                                                        )}
                                                    >
                                                        {doc.title}
                                                    </span>
                                                </div>
                                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-tertiary">
                                                    <span>{DOC_KIND_LABELS[doc.kind]}</span>
                                                    <span>·</span>
                                                    <span>{doc.sectionCount} 章节</span>
                                                    <span>·</span>
                                                    <span>{doc.wordCount} 字</span>
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </section>

                {/* 正文编辑 */}
                <section className="rounded-xl border border-border-subtle bg-surface">
                    {!selectedDocId ? (
                        <div className="px-4 py-16 text-center">
                            <PenLine className="mx-auto h-6 w-6 text-tertiary" />
                            <p className="mt-2 text-[12px] text-secondary">从左侧选择或新建一个文档开始写作</p>
                        </div>
                    ) : docLoading ? (
                        <LoadingBlock label="加载文档…" />
                    ) : docError ? (
                        <div className="p-4">
                            <ErrorBanner message={docError} onRetry={() => selectedDocId && void loadDocument(selectedDocId)} />
                        </div>
                    ) : !document ? (
                        <div className="px-4 py-16 text-center text-[12px] text-secondary">文档不存在或无权访问</div>
                    ) : (
                        <div>
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-2.5">
                                <div className="min-w-0">
                                    <h3 className="truncate text-[13px] font-semibold text-foreground">
                                        {document.title}
                                    </h3>
                                    <p className="mt-0.5 text-[11px] text-tertiary">
                                        {DOC_KIND_LABELS[document.kind]} · {sections.length} 章节 · 更新{" "}
                                        {formatDateTime(document.updatedAt)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => void exportDocument("markdown")}
                                        disabled={busy !== null}
                                        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                                    >
                                        {busy === "export-markdown" ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <Download className="h-3 w-3" />
                                        )}
                                        Markdown
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void exportDocument("latex")}
                                        disabled={busy !== null}
                                        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                                    >
                                        {busy === "export-latex" ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <Download className="h-3 w-3" />
                                        )}
                                        LaTeX
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-0 md:grid-cols-[190px_1fr]">
                                {/* 章节列表 */}
                                <div className="border-b border-border-subtle p-2 md:border-b-0 md:border-r">
                                    <div className="flex items-center justify-between px-1.5 py-1">
                                        <span className="text-[11px] font-medium text-secondary">章节</span>
                                        <button
                                            type="button"
                                            onClick={startNewSection}
                                            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent-soft"
                                        >
                                            <FilePlus2 className="h-3 w-3" />
                                            新增
                                        </button>
                                    </div>
                                    <ul className="mt-1 space-y-0.5">
                                        {sections.map((section) => {
                                            const active = section.key === selectedKey;
                                            return (
                                                <li key={section.key}>
                                                    <button
                                                        type="button"
                                                        onClick={() => selectSection(section)}
                                                        className={cn(
                                                            "w-full truncate rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                                                            active
                                                                ? "bg-accent-soft text-accent"
                                                                : "text-secondary hover:bg-border-subtle hover:text-foreground",
                                                        )}
                                                        title={`${section.title}（${section.key}）`}
                                                    >
                                                        {section.title}
                                                    </button>
                                                </li>
                                            );
                                        })}
                                        {sections.length === 0 && (
                                            <li className="px-2 py-2 text-[11px] text-tertiary">暂无章节</li>
                                        )}
                                    </ul>
                                </div>

                                {/* 编辑区 */}
                                <div className="p-3">
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            value={editorTitle}
                                            onChange={(e) => setEditorTitle(e.target.value)}
                                            maxLength={200}
                                            placeholder="章节标题"
                                            className="field h-9 flex-1 py-0 text-[13px] font-medium"
                                        />
                                        {editorKey ? (
                                            <Pill className="shrink-0 font-mono">{editorKey}</Pill>
                                        ) : (
                                            <Pill className="shrink-0">新章节</Pill>
                                        )}
                                    </div>
                                    <textarea
                                        value={editorContent}
                                        onChange={(e) => setEditorContent(e.target.value)}
                                        rows={14}
                                        placeholder="章节正文（Markdown 或纯文本）"
                                        className="field mt-2 resize-y font-mono text-[12px] leading-relaxed"
                                    />
                                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                        <p className="text-[11px] text-tertiary">
                                            {editorKey
                                                ? "按 key 覆盖保存该章节；改标题不会影响已有引用。"
                                                : "新章节按标题保存（保存后生成 key）。"}
                                        </p>
                                        <div className="flex items-center gap-1.5">
                                            {editorKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const section = sections.find((item) => item.key === editorKey);
                                                        if (section) setPendingDelete(section);
                                                    }}
                                                    disabled={busy !== null}
                                                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                    删除章节
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => void saveSection()}
                                                disabled={busy !== null || !editorTitle.trim()}
                                                className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                                            >
                                                {busy === "save" ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <Save className="h-3 w-3" />
                                                )}
                                                保存章节
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </section>
            </div>

            <ConfirmDialog
                open={pendingDelete !== null}
                title="删除章节"
                message={
                    pendingDelete
                        ? `确认删除章节「${pendingDelete.title}」？正文内容会一并删除。`
                        : undefined
                }
                confirmLabel="删除"
                danger
                busy={busy !== null}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => {
                    const target = pendingDelete;
                    if (target) void removeSection(target);
                }}
            />

            <Modal
                open={exportResult !== null}
                title={exportResult?.format === "latex" ? "LaTeX 导出" : "Markdown 导出"}
                icon={Download}
                onClose={() => setExportResult(null)}
                width="max-w-[760px]"
            >
                <div className="space-y-3">
                    <p className="text-[12px] text-secondary">
                        《{exportResult?.title}》{exportResult?.format === "latex" ? "（\documentclass 完整文档）" : ""}
                    </p>
                    <textarea
                        readOnly
                        value={exportResult?.text ?? ""}
                        rows={18}
                        className="field resize-y font-mono text-[11px]"
                        onFocus={(e) => e.currentTarget.select()}
                    />
                    {copyHint && <p className="text-[11px] text-success">{copyHint}</p>}
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setExportResult(null)}
                            className="rounded-full px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                        >
                            关闭
                        </button>
                        <button
                            type="button"
                            onClick={() => void copy(exportResult?.text ?? "", "已复制导出文本")}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-border-subtle"
                        >
                            <Copy className="h-3 w-3" />
                            复制
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                const ext = exportResult?.format === "latex" ? "tex" : "md";
                                downloadText(
                                    `${exportResult?.title ?? "document"}.${ext}`,
                                    exportResult?.text ?? "",
                                );
                            }}
                            className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                        >
                            <Download className="h-3 w-3" />
                            下载
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
