/**
 * 文献 tab：BibTeX / CSL-JSON 导入 → 列表核验 → 导出。
 * 复用桌面端 .card/.tabs/.button/.status/.text-input 与主题变量，无独立图标。
 */

import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../lib/toast";
import {
  deleteLiterature, exportLiteratureBibtex, importLiterature, listLiterature,
  parseAuthors, verifyLiterature,
  type LiteratureFormat, type LiteratureImportResult, type LiteratureRef,
} from "../../lib/research";
import { copyToClipboard, errorText, formatYear } from "./common";

const STATUS_LABEL: Record<string, string> = { unverified: "待核验", verified: "已核验", missing: "未找到" };
function statusClass(status: string): string {
  if (status === "verified") return "status status--ok";
  if (status === "missing") return "status status--error";
  return "status";
}
function detectFormat(text: string): LiteratureFormat {
  const head = text.trimStart();
  if (head.startsWith("@")) return "bibtex";
  if (head.startsWith("[") || head.startsWith("{")) return "csl";
  return "bibtex";
}
function describeImport(result: LiteratureImportResult): string {
  const parts = ["新增 " + result.imported + " 条"];
  if (result.skipped > 0) parts.push("跳过重复 " + result.skipped + " 条");
  if (result.failed > 0) parts.push("解析失败 " + result.failed + " 条");
  return parts.join("，");
}

export default function LiteratureTab({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [refs, setRefs] = useState<LiteratureRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<"auto" | LiteratureFormat>("auto");
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listLiterature(projectId)
      .then((rows) => { if (!cancelled) setRefs(rows); })
      .catch((err) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleImport(): Promise<void> {
    const raw = content.trim();
    if (raw === "") { setError("请先粘贴 BibTeX 或 CSL-JSON 内容"); return; }
    setImporting(true); setError(null); setNotice(null); setImportErrors([]);
    try {
      const result = await importLiterature(projectId, format === "auto" ? detectFormat(raw) : format, raw);
      setRefs(await listLiterature(projectId));
      setContent("");
      setNotice(describeImport(result));
      if (result.errors.length > 0) setImportErrors(result.errors);
      if (result.imported > 0) toast.success(describeImport(result), { title: "文献导入完成" });
      else toast.warning(describeImport(result), { title: "没有新增文献" });
    } catch (err) { setError(errorText(err)); }
    finally { setImporting(false); }
  }

  async function handleVerify(ref: LiteratureRef): Promise<void> {
    setVerifyingId(ref.id); setError(null); setNotice(null);
    try {
      const updated = await verifyLiterature(projectId, ref.id);
      setRefs((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      if (updated.status === "verified") setNotice("「" + updated.title + "」已通过 Crossref 核验");
      else if (updated.status === "missing") setNotice("「" + updated.title + "」未找到匹配记录，请核对 DOI / 标题");
      else setNotice("「" + updated.title + "」核验已返回：" + (STATUS_LABEL[updated.status] ?? updated.status));
      toast.success(updated.status === "verified" ? "Crossref 核验通过" : "核验已返回", { title: "文献核验" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "文献核验失败" }); }
    finally { setVerifyingId(null); }
  }

  async function handleDelete(ref: LiteratureRef): Promise<void> {
    const confirmed = await confirm("删除文献「" + ref.title + "」？该操作不可恢复。", { title: "删除文献", kind: "warning" });
    if (!confirmed) return;
    setDeletingId(ref.id); setError(null);
    try {
      await deleteLiterature(projectId, ref.id);
      setRefs((prev) => prev.filter((row) => row.id !== ref.id));
      toast.success("已删除该文献", { title: "文献" });
    } catch (err) { toast.error(errorText(err), { title: "删除失败" }); }
    finally { setDeletingId(null); }
  }

  async function handleExport(): Promise<void> {
    setExporting(true); setError(null); setNotice(null);
    try {
      const bibtex = await exportLiteratureBibtex(projectId);
      if (bibtex.trim() === "") { setNotice("当前项目还没有可导出的文献，先导入几条再试"); return; }
      setExported(bibtex);
      const ok = await copyToClipboard(bibtex);
      if (ok) toast.success("已复制 " + refs.length + " 条文献的 BibTeX", { title: "导出 BibTeX" });
      else setError("复制到剪贴板失败：请从下方文本框手动全选复制");
    } catch (err) { setError(errorText(err)); }
    finally { setExporting(false); }
  }

  const verified = refs.filter((row) => row.status === "verified").length;

  return (
    <div className="rs-pane">
      {error !== null && <p className="error-text" style={{ margin: 0 }} onClick={() => setError(null)}>{error}</p>}
      {notice !== null && <p className="hint-text" style={{ margin: 0 }} onClick={() => setNotice(null)}>{notice}</p>}

      <div className="card">
        <div className="research-section-head">
          <h3>导入文献</h3>
          <span className="hint-text">BibTeX 或 CSL-JSON；导入后为「待核验」</span>
          <span className="spacer" />
          <button type="button" className="button research-btn-sm" disabled={exporting || refs.length === 0} onClick={() => void handleExport()}>
            {exporting ? "导出中…" : "导出 BibTeX"}
          </button>
        </div>

        <textarea className="research-textarea research-mono" style={{ minHeight: 130 }}
          placeholder={"@article{zhang2024,\n  title = {…},\n  author = {Zhang, San and Li, Si},\n  year = {2024}\n}\n\n或：[{\"id\":\"…\",\"title\":\"…\"}]"}
          value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />

        <div className="research-row" style={{ marginTop: 10 }}>
          <span className="hint-text">格式</span>
          <div className="tabs" role="group" aria-label="导入格式">
            {([
              { value: "auto", label: "自动识别" },
              { value: "bibtex", label: "BibTeX" },
              { value: "csl", label: "CSL-JSON" },
            ] as Array<{ value: "auto" | LiteratureFormat; label: string }>).map((item) => (
              <button key={item.value} type="button" className={format === item.value ? "tab tab--active" : "tab"}
                onClick={() => setFormat(item.value)}>{item.label}</button>
            ))}
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="button button--primary" disabled={importing} onClick={() => void handleImport()}>
            {importing ? "导入中…" : "导入"}
          </button>
        </div>

        {importErrors.length > 0 && (
          <p className="error-text" style={{ margin: "10px 0 0" }}>
            部分条目解析失败：<br />{importErrors.join("\n")}
          </p>
        )}

        {exported !== null && (
          <div style={{ marginTop: 12 }}>
            <div className="research-row">
              <span className="hint-text" style={{ flex: 1 }}>导出的 BibTeX 全文（复制失败时可手动全选）</span>
              <button type="button" className="button research-btn-sm" onClick={() => setExported(null)}>收起</button>
            </div>
            <textarea readOnly className="research-textarea research-mono" style={{ minHeight: 110, marginTop: 6 }}
              value={exported} spellCheck={false} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="research-section-head">
          <h3>文献库</h3>
          <span className="hint-text">{refs.length + " 条 · 已核验 " + verified + " 条"}</span>
        </div>

        {loading ? <p className="hint-text">加载文献…</p> : refs.length === 0 ? (
          <div className="research-empty"><p>还没有文献。选题 / 研究设计阶段建议先导入 10–20 条核心文献。</p></div>
        ) : (
          <div className="rs-table-wrap"><table className="research-table">
            <thead><tr><th>标题</th><th style={{ width: 64 }}>年份</th><th style={{ width: 90 }}>状态</th><th style={{ width: 140 }}>操作</th></tr></thead>
            <tbody>
              {refs.map((row) => {
                const authors = parseAuthors(row.authorsJson);
                const meta = [row.citeKey, row.venue, authors.join(", "), row.doi !== "" ? "DOI " + row.doi : ""]
                  .filter((value) => value !== "").join(" · ");
                return (
                  <tr key={row.id}>
                    <td><div className="research-table__title">{row.title}</div><div className="research-table__meta">{meta}</div></td>
                    <td>{formatYear(row.year)}</td>
                    <td><span className={statusClass(row.status)}>{STATUS_LABEL[row.status] ?? row.status}</span></td>
                    <td>
                      <div className="research-row" style={{ flexWrap: "nowrap", gap: 4 }}>
                        <button type="button" className="button research-btn-sm" disabled={verifyingId === row.id} onClick={() => void handleVerify(row)}>
                          {verifyingId === row.id ? "核验中…" : "核验"}
                        </button>
                        <button type="button" className="button research-btn-sm" style={{ color: "var(--danger)" }}
                          disabled={deletingId === row.id} onClick={() => void handleDelete(row)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        {refs.length > 0 && <p className="hint-text" style={{ marginTop: 10 }}>「未找到」表示 Crossref 查不到，可能是 DOI 缺失或标题改写。</p>}
      </div>
    </div>
  );
}
