"use client";

/**
 * 文献库 Tab：在线检索候选 → 加入项目库、手动添加、分页列表、
 * DOI 核验、删除、BibTeX 导出（复制/下载）。
 *
 * 引用纪律与后端一致：检索命中的候选一律未核验，只有「核验」成功
 * （Crossref 命中且标题一致）才显示已核验；正文只应引用库内 citeKey。
 */
import { useCallback, useEffect, useState } from "react";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    Download,
    ExternalLink,
    Loader2,
    Plus,
    Search,
    ShieldCheck,
    Trash2,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
    academicApi,
    type AcademicLiteratureEntry,
    type AcademicLiteratureHit,
    type AcademicLiteratureSearchSource,
} from "@/lib/api";
import {
    ErrorBanner,
    LITERATURE_SOURCE_LABELS,
    LoadingBlock,
    Modal,
    Pill,
    copyText,
    downloadText,
} from "./research-ui";

const PAGE_SIZE = 20;

const SEARCH_SOURCES: { value: AcademicLiteratureSearchSource; label: string }[] = [
    { value: "auto", label: "自动（Crossref 优先）" },
    { value: "crossref", label: "Crossref" },
    { value: "openalex", label: "OpenAlex" },
    { value: "arxiv", label: "arXiv" },
];

function authorsLine(authors: string[]): string {
    if (authors.length === 0) return "作者未知";
    const shown = authors.slice(0, 6).join(", ");
    return authors.length > 6 ? `${shown} 等` : shown;
}

export function LiteratureTab({
    projectId,
    onChanged,
}: {
    projectId: string;
    onChanged: () => Promise<void>;
}) {
    const [entries, setEntries] = useState<AcademicLiteratureEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    // 在线检索
    const [keyword, setKeyword] = useState("");
    const [source, setSource] = useState<AcademicLiteratureSearchSource>("auto");
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [hits, setHits] = useState<AcademicLiteratureHit[]>([]);
    const [searched, setSearched] = useState(false);

    // 手动添加
    const [manualOpen, setManualOpen] = useState(false);
    const [manualTitle, setManualTitle] = useState("");
    const [manualAuthors, setManualAuthors] = useState("");
    const [manualYear, setManualYear] = useState("");
    const [manualVenue, setManualVenue] = useState("");
    const [manualDoi, setManualDoi] = useState("");
    const [manualUrl, setManualUrl] = useState("");

    // 删除确认 / 导出
    const [pendingDelete, setPendingDelete] = useState<AcademicLiteratureEntry | null>(null);
    const [exportText, setExportText] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);

    const load = useCallback(
        async (targetOffset: number) => {
            setLoading(true);
            setError(null);
            try {
                const page = await academicApi.listLiterature(projectId, {
                    limit: PAGE_SIZE,
                    offset: targetOffset,
                });
                setEntries(page.entries);
                setTotal(page.total);
            } catch (e) {
                setError(e instanceof Error ? e.message : "加载文献库失败");
            } finally {
                setLoading(false);
            }
        },
        [projectId],
    );

    useEffect(() => {
        setOffset(0);
        void load(0);
    }, [load]);

    // 项目切换时清空检索/表单状态，避免跨项目串数据。
    useEffect(() => {
        setHits([]);
        setSearched(false);
        setKeyword("");
        setManualOpen(false);
        setNotice(null);
        setSearchError(null);
        setError(null);
    }, [projectId]);

    function flash(message: string) {
        setNotice(message);
    }

    async function refreshAfterWrite() {
        await load(offset);
        await onChanged();
    }

    async function search() {
        const q = keyword.trim();
        if (!q) return;
        setSearching(true);
        setSearchError(null);
        setNotice(null);
        try {
            const result = await academicApi.searchLiterature(q, { limit: 10, source });
            setHits(result.hits);
            setSearched(true);
        } catch (e) {
            setSearchError(e instanceof Error ? e.message : "检索失败");
        } finally {
            setSearching(false);
        }
    }

    async function addHit(hit: AcademicLiteratureHit) {
        const key = hit.title;
        setBusy(`hit-${key}`);
        setNotice(null);
        setError(null);
        try {
            const result = await academicApi.addLiterature(projectId, {
                title: hit.title,
                authors: hit.authors.length > 0 ? hit.authors : undefined,
                year: hit.year,
                venue: hit.venue,
                doi: hit.doi,
                url: hit.url,
                abstract: hit.abstract,
            });
            flash(
                result.duplicate
                    ? `库中已有该文献：[${result.entry.citeKey}]《${result.entry.title}》，未重复加入。`
                    : `已加入文献库：[${result.entry.citeKey}]《${result.entry.title}》（未核验）。`,
            );
            await refreshAfterWrite();
        } catch (e) {
            setError(e instanceof Error ? e.message : "加入失败");
        } finally {
            setBusy(null);
        }
    }

    async function submitManual() {
        if (!manualTitle.trim()) return;
        setBusy("manual");
        setNotice(null);
        setError(null);
        try {
            const year = manualYear.trim() ? Number.parseInt(manualYear.trim(), 10) : undefined;
            const result = await academicApi.addLiterature(projectId, {
                title: manualTitle.trim(),
                authors: manualAuthors
                    .split(/[,，、;；\n]+/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                year: Number.isFinite(year) ? year : undefined,
                venue: manualVenue.trim() || undefined,
                doi: manualDoi.trim() || undefined,
                url: manualUrl.trim() || undefined,
            });
            flash(
                result.duplicate
                    ? `库中已有该文献：[${result.entry.citeKey}]《${result.entry.title}》。`
                    : `已加入文献库：[${result.entry.citeKey}]《${result.entry.title}》（未核验）。`,
            );
            setManualTitle("");
            setManualAuthors("");
            setManualYear("");
            setManualVenue("");
            setManualDoi("");
            setManualUrl("");
            setManualOpen(false);
            await refreshAfterWrite();
        } catch (e) {
            setError(e instanceof Error ? e.message : "添加失败");
        } finally {
            setBusy(null);
        }
    }

    async function verify(entry: AcademicLiteratureEntry) {
        setBusy(`verify-${entry.id}`);
        setNotice(null);
        setError(null);
        try {
            const result = await academicApi.verifyLiterature(projectId, entry.citeKey);
            flash(result.message || (result.verified ? "已核验。" : "未核验。"));
            await refreshAfterWrite();
        } catch (e) {
            setError(e instanceof Error ? e.message : "核验失败");
        } finally {
            setBusy(null);
        }
    }

    async function remove(entry: AcademicLiteratureEntry) {
        setBusy(`delete-${entry.id}`);
        setNotice(null);
        setError(null);
        try {
            await academicApi.deleteLiterature(projectId, entry.citeKey);
            flash(`已移除 [${entry.citeKey}]《${entry.title}》。`);
            // 删掉当前页最后一条时回退一页，避免停在空页。
            const nextOffset = entries.length === 1 && offset > 0 ? Math.max(0, offset - PAGE_SIZE) : offset;
            setOffset(nextOffset);
            await load(nextOffset);
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除失败");
        } finally {
            setPendingDelete(null);
            setBusy(null);
        }
    }

    async function exportBibtex() {
        setBusy("export");
        setError(null);
        try {
            const result = await academicApi.exportBibtex(projectId);
            setExportText(result.bibtex);
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

    const pageIndex = Math.floor(offset / PAGE_SIZE) + 1;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} onRetry={() => void load(offset)} />}
            {notice && (
                <div className="flex items-start gap-2 rounded-lg border-l-2 border-success bg-success/5 px-3 py-2.5 text-[12px] text-success">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{notice}</span>
                </div>
            )}

            {/* 在线检索 */}
            <section className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Search className="h-3.5 w-3.5" />
                        在线检索文献
                    </h3>
                    <button
                        type="button"
                        onClick={() => setManualOpen((open) => !open)}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle"
                    >
                        <Plus className="h-3 w-3" />
                        手动添加
                    </button>
                </div>

                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void search();
                    }}
                    className="mt-2 flex flex-col gap-2 sm:flex-row"
                >
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
                        <input
                            value={keyword}
                            onChange={(e) => setKeyword(e.target.value)}
                            placeholder="标题、作者或关键词（英文命中率更高）"
                            className="field h-9 py-0 pl-8 text-[12px]"
                        />
                    </div>
                    <select
                        value={source}
                        onChange={(e) => setSource(e.target.value as AcademicLiteratureSearchSource)}
                        className="h-9 rounded-lg border border-border bg-surface px-2 text-[12px] text-foreground outline-none"
                    >
                        {SEARCH_SOURCES.map((item) => (
                            <option key={item.value} value={item.value}>
                                {item.label}
                            </option>
                        ))}
                    </select>
                    <button
                        type="submit"
                        disabled={searching || !keyword.trim()}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-foreground px-4 text-[12px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                        {searching && <Loader2 className="h-3 w-3 animate-spin" />}
                        检索
                    </button>
                </form>

                {searchError && (
                    <div className="mt-2">
                        <ErrorBanner message={searchError} />
                    </div>
                )}

                {manualOpen && (
                    <div className="mt-3 space-y-2 rounded-lg border border-border-subtle bg-border-subtle/30 p-3">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <label className="text-[11px] text-secondary">
                                标题 <span className="text-danger">*</span>
                                <input
                                    value={manualTitle}
                                    onChange={(e) => setManualTitle(e.target.value)}
                                    maxLength={500}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="文献标题"
                                />
                            </label>
                            <label className="text-[11px] text-secondary">
                                作者（逗号分隔）
                                <input
                                    value={manualAuthors}
                                    onChange={(e) => setManualAuthors(e.target.value)}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="San Zhang, Si Li"
                                />
                            </label>
                            <label className="text-[11px] text-secondary">
                                年份
                                <input
                                    value={manualYear}
                                    onChange={(e) => setManualYear(e.target.value.replace(/[^0-9]/g, ""))}
                                    maxLength={4}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="2024"
                                />
                            </label>
                            <label className="text-[11px] text-secondary">
                                期刊 / 会议
                                <input
                                    value={manualVenue}
                                    onChange={(e) => setManualVenue(e.target.value)}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="NeurIPS"
                                />
                            </label>
                            <label className="text-[11px] text-secondary">
                                DOI
                                <input
                                    value={manualDoi}
                                    onChange={(e) => setManualDoi(e.target.value)}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="10.1000/xyz"
                                />
                            </label>
                            <label className="text-[11px] text-secondary">
                                URL
                                <input
                                    value={manualUrl}
                                    onChange={(e) => setManualUrl(e.target.value)}
                                    className="field mt-1 h-8 py-0 text-[12px]"
                                    placeholder="https://…"
                                />
                            </label>
                        </div>
                        <div className="flex items-center justify-between">
                            <p className="text-[11px] text-tertiary">只填写确定的信息，不要编造 DOI/作者/年份。</p>
                            <button
                                type="button"
                                onClick={() => void submitManual()}
                                disabled={busy !== null || !manualTitle.trim()}
                                className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                            >
                                {busy === "manual" && <Loader2 className="h-3 w-3 animate-spin" />}
                                加入文献库
                            </button>
                        </div>
                    </div>
                )}

                {hits.length > 0 && (
                    <ul className="mt-3 space-y-2">
                        {hits.map((hit) => (
                            <li
                                key={`${hit.source}:${hit.title}:${hit.doi ?? ""}`}
                                className="flex flex-col gap-1 rounded-lg border border-border-subtle p-2.5 sm:flex-row sm:items-start"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="text-[13px] font-medium text-foreground">《{hit.title}》</div>
                                    <div className="mt-0.5 text-[11px] text-secondary">
                                        {authorsLine(hit.authors)}
                                        {hit.year ? `｜${hit.year}` : ""}
                                        {hit.venue ? `｜${hit.venue}` : ""}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                        <Pill>{LITERATURE_SOURCE_LABELS[hit.source] ?? hit.source}</Pill>
                                        <Pill className="bg-warning/10 text-warning">未核验</Pill>
                                        {hit.doi && <span className="text-[11px] text-tertiary">DOI: {hit.doi}</span>}
                                        {hit.url && (
                                            <a
                                                href={hit.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline"
                                            >
                                                链接 <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                        )}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void addHit(hit)}
                                    disabled={busy !== null}
                                    className="inline-flex shrink-0 items-center gap-1 self-start rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                                >
                                    {busy === `hit-${hit.title}` ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Plus className="h-3 w-3" />
                                    )}
                                    加入
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {searched && hits.length === 0 && !searching && (
                    <p className="mt-3 text-[12px] text-tertiary">
                        没有检索到相关文献，可换更通用的英文关键词，或用「手动添加」录入。
                    </p>
                )}
            </section>

            {/* 文献库列表 */}
            <section className="rounded-xl border border-border-subtle bg-surface">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                    <h3 className="text-[13px] font-semibold text-foreground">
                        项目文献库
                        <span className="ml-1.5 text-[11px] font-normal text-tertiary">共 {total} 篇</span>
                    </h3>
                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => void load(offset)}
                            disabled={loading}
                            className="rounded-full border border-border px-3 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                        >
                            刷新
                        </button>
                        <button
                            type="button"
                            onClick={() => void exportBibtex()}
                            disabled={busy !== null || total === 0}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                        >
                            {busy === "export" ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Download className="h-3 w-3" />
                            )}
                            导出 BibTeX
                        </button>
                    </div>
                </div>

                {loading ? (
                    <LoadingBlock label="加载文献库…" />
                ) : entries.length === 0 ? (
                    <div className="px-4 py-10 text-center text-[12px] text-secondary">
                        文献库还没有文献。可检索候选加入，或在对话中让学术 agent 导入 BibTeX/CSL。
                    </div>
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {entries.map((entry, index) => (
                            <li key={entry.id} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-start">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-[11px] text-tertiary">{offset + index + 1}.</span>
                                        <span className="rounded bg-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                                            {entry.citeKey}
                                        </span>
                                        <span className="text-[13px] font-medium text-foreground">《{entry.title}》</span>
                                        {entry.verified ? (
                                            <Pill className="bg-success/10 text-success">
                                                <ShieldCheck className="h-2.5 w-2.5" />
                                                已核验
                                            </Pill>
                                        ) : (
                                            <Pill className="bg-warning/10 text-warning">未核验</Pill>
                                        )}
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-secondary">
                                        {authorsLine(entry.authors)}
                                        {entry.year ? `｜${entry.year}` : ""}
                                        {entry.venue ? `｜${entry.venue}` : ""}
                                        {entry.doi ? `｜DOI: ${entry.doi}` : ""}
                                        {`｜来源：${LITERATURE_SOURCE_LABELS[entry.source] ?? entry.source}`}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => void verify(entry)}
                                        disabled={busy !== null}
                                        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                                    >
                                        {busy === `verify-${entry.id}` ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <ShieldCheck className="h-3 w-3" />
                                        )}
                                        核验
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPendingDelete(entry)}
                                        disabled={busy !== null}
                                        aria-label="删除文献"
                                        className="grid h-7 w-7 place-items-center rounded-full text-tertiary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                {total > PAGE_SIZE && (
                    <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5 text-[11px] text-secondary">
                        <span>
                            第 {pageIndex} / {pageCount} 页
                        </span>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => {
                                    const next = Math.max(0, offset - PAGE_SIZE);
                                    setOffset(next);
                                    void load(next);
                                }}
                                disabled={offset === 0 || loading}
                                className="grid h-7 w-7 place-items-center rounded-full border border-border transition-colors hover:bg-border-subtle disabled:opacity-40"
                                aria-label="上一页"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    const next = offset + PAGE_SIZE;
                                    setOffset(next);
                                    void load(next);
                                }}
                                disabled={offset + PAGE_SIZE >= total || loading}
                                className="grid h-7 w-7 place-items-center rounded-full border border-border transition-colors hover:bg-border-subtle disabled:opacity-40"
                                aria-label="下一页"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}
            </section>

            <ConfirmDialog
                open={pendingDelete !== null}
                title="移除文献"
                message={
                    pendingDelete
                        ? `确认从项目文献库移除 [${pendingDelete.citeKey}]《${pendingDelete.title}》？正文中的引用不会自动清理。`
                        : undefined
                }
                confirmLabel="移除"
                danger
                busy={busy !== null}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => {
                    const target = pendingDelete;
                    if (target) void remove(target);
                }}
            />

            <Modal
                open={exportText !== null}
                title="项目文献库 BibTeX"
                icon={Download}
                onClose={() => setExportText(null)}
                width="max-w-[720px]"
            >
                <div className="space-y-3">
                    <p className="text-[12px] text-secondary">共 {total} 篇。可直接复制粘贴为 .bib 文件。</p>
                    <textarea
                        readOnly
                        value={exportText ?? ""}
                        rows={16}
                        className="field resize-y font-mono text-[11px]"
                        onFocus={(e) => e.currentTarget.select()}
                    />
                    {copyHint && <p className="text-[11px] text-success">{copyHint}</p>}
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setExportText(null)}
                            className="rounded-full px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                        >
                            关闭
                        </button>
                        <button
                            type="button"
                            onClick={() => void copy(exportText ?? "", "已复制 BibTeX")}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-border-subtle"
                        >
                            <Copy className="h-3 w-3" />
                            复制
                        </button>
                        <button
                            type="button"
                            onClick={() => downloadText(`${projectId}-literature.bib`, exportText ?? "", "application/x-bibtex;charset=utf-8")}
                            className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                        >
                            <Download className="h-3 w-3" />
                            下载 .bib
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
