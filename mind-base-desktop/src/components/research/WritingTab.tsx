/**
 * 写作 tab：章节编辑 + DOCX 导出 + Cover Letter。
 * 复用桌面端 .card/.button/.text-input 与主题变量，无独立图标。
 */

import { useEffect, useMemo, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../lib/toast";
import {
  DEFAULT_MANUSCRIPT_SECTIONS, deleteManuscript, exportDocx,
  listManuscript, saveManuscript, type DocxExport, type ManuscriptSection,
} from "../../lib/research";
import { copyToClipboard, errorText } from "./common";
import { HOME_HASH, navigate } from "../../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../../lib/chat";
import { setActiveResearchProject, setPendingResearchPrompt, setResearchNewChatFlag } from "../../lib/research-context";

const COVER_LETTER_PROMPT = [
  "请为本项目写一封投稿用的 Cover Letter：",
  "1) 用英文正文概括研究问题、方法、主要贡献与与目标期刊的契合点（300 词以内）；",
  "2) 另起一段用中文列出 3 条投稿前仍需要我确认的信息（如作者顺序、伦理声明、数据可用性）。",
  "不要编造未在项目章节或简报里出现的实验数字。",
].join("");
const STATUS_LABEL: Record<string, string> = { draft: "草稿", review: "待审", ready: "待审", final: "定稿", done: "已完成" };

function placeholderSection(section: string, ord: number): ManuscriptSection {
  return { id: "", section, ord, path: "", words: 0, status: "draft", updatedAt: 0, content: "" };
}
function describeExport(info: DocxExport): string {
  const parts: string[] = [];
  if (typeof info.sections === "number") parts.push(info.sections + " 个章节");
  if (typeof info.words === "number") parts.push(info.words + " 字");
  return parts.length > 0 ? parts.join(" · ") : "已导出";
}

export default function WritingTab({
  projectId, onDirtyChange,
}: { projectId: string; onDirtyChange?: (dirty: boolean) => void }): React.JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<ManuscriptSection[]>([]);
  const [selectedSection, setSelectedSection] = useState<string>(DEFAULT_MANUSCRIPT_SECTIONS[0]);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState<DocxExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listManuscript(projectId)
      .then((loaded) => {
        if (cancelled) return;
        setRows(loaded);
        const byOrder = [...loaded].sort((a, b) => a.ord - b.ord);
        const initial = byOrder.find((row) => row.words > 0)?.section ?? byOrder[0]?.section ?? DEFAULT_MANUSCRIPT_SECTIONS[0];
        setSelectedSection(initial);
        setDraft(loaded.find((row) => row.section === initial)?.content ?? "");
        setDirty(false);
      })
      .catch((err) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const ordered = useMemo<ManuscriptSection[]>(() => {
    const known = new Map(rows.map((row) => [row.section, row] as const));
    const base = DEFAULT_MANUSCRIPT_SECTIONS.map((section, index) => {
      const row = known.get(section);
      known.delete(section);
      return row ?? placeholderSection(section, index);
    });
    return [...base, ...[...known.values()].sort((a, b) => a.ord - b.ord)];
  }, [rows]);

  const selectedRow = rows.find((row) => row.section === selectedSection);
  const totalWords = rows.reduce((sum, row) => sum + (Number.isFinite(row.words) ? row.words : 0), 0);

  async function handleSelect(section: string): Promise<void> {
    if (section === selectedSection) return;
    if (dirty) {
      const confirmed = await confirm("当前章节有未保存的改动，切换会丢弃这些改动。继续？", { title: "未保存的改动", kind: "warning" });
      if (!confirmed) return;
    }
    setSelectedSection(section);
    setDraft(rows.find((row) => row.section === section)?.content ?? "");
    setDirty(false); setNotice(null); setError(null);
  }
  async function handleSave(): Promise<void> {
    if (saving) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = await saveManuscript(projectId, selectedSection, draft);
      setRows((prev) => [...prev.filter((row) => row.section !== saved.section), saved]);
      if (typeof saved.content === "string") setDraft(saved.content);
      setDirty(false);
      setNotice("「" + saved.section + "」已保存（" + saved.words + " 字）");
      toast.success("章节已保存", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "保存失败" }); }
    finally { setSaving(false); }
  }
  async function handleDelete(): Promise<void> {
    if (selectedRow === undefined) { setNotice("该章节还没有保存过正文，无需删除"); return; }
    const confirmed = await confirm("删除章节「" + selectedSection + "」已保存的正文（" + selectedRow.words + " 字）？该操作不可恢复。", { title: "删除章节", kind: "warning" });
    if (!confirmed) return;
    setDeleting(true); setError(null);
    try {
      await deleteManuscript(projectId, selectedSection);
      setRows((prev) => prev.filter((row) => row.section !== selectedSection));
      setDraft(""); setDirty(false); setNotice("已删除「" + selectedSection + "」");
      toast.success("章节已删除", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "删除失败" }); }
    finally { setDeleting(false); }
  }
  async function handleExport(): Promise<void> {
    setExporting(true); setError(null);
    try {
      const info = await exportDocx(projectId);
      setExportInfo(info);
      toast.success("DOCX 已导出", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "导出失败" }); }
    finally { setExporting(false); }
  }
  /** Cover Letter 也在主聊天生成：绑定项目 + 预填指令 + 跳转。 */
  function openCoverLetterInChat(): void {
    setActiveResearchProject(projectId);
    setPendingResearchPrompt(COVER_LETTER_PROMPT);
    setResearchNewChatFlag();
    window.sessionStorage.setItem(CHAT_MODE_JUMP_KEY, "chat");
    navigate(HOME_HASH);
  }
  async function copyText(text: string, label: string): Promise<void> {
    const ok = await copyToClipboard(text);
    if (ok) toast.success("已复制" + label, { title: "写作" });
    else setError("复制" + label + "失败：请手动选中复制");
  }

  return (
    <div className="rs-pane">
      {error !== null && <p className="error-text" style={{ margin: 0 }} onClick={() => setError(null)}>{error}</p>}
      {notice !== null && <p className="hint-text" style={{ margin: 0 }} onClick={() => setNotice(null)}>{notice}</p>}

      <div className="research-write">
        <div className="card">
          <div className="research-section-head"><h3>章节</h3><span className="hint-text">{totalWords + " 字"}</span></div>
          {loading ? <p className="hint-text">加载章节…</p> : (
            <div className="research-sections">
              {ordered.map((row) => (
                <button key={row.section} type="button"
                  className={row.section === selectedSection ? "research-section-item is-active" : "research-section-item"}
                  onClick={() => void handleSelect(row.section)}>
                  <span className="research-section-item__name">{row.section}</span>
                  <span className="research-section-item__words">{row.words > 0 ? row.words : "—"}</span>
                  {row.section === selectedSection && dirty && <span style={{ color: "var(--g-blue)" }}>●</span>}
                </button>
              ))}
            </div>
          )}
          <p className="hint-text" style={{ marginTop: 10 }}>章节名会作为 DOCX 标题；没有正文的章节不会进入导出。</p>
        </div>

        <div className="card">
          <div className="research-section-head">
            <h3>{selectedSection}</h3>
            <span className="hint-text">{"约 " + [...draft].length + " 字" + (dirty ? " · 未保存" : "")}</span>
            {selectedRow !== undefined && <span className="status">{STATUS_LABEL[selectedRow.status] ?? selectedRow.status}</span>}
            <span className="spacer" />
            <button type="button" className="button research-btn-sm" disabled={saving || !dirty} onClick={() => void handleSave()}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button type="button" className="button research-btn-sm" style={{ color: "var(--danger)" }}
              disabled={deleting || selectedRow === undefined} onClick={() => void handleDelete()}>删除</button>
          </div>
          <textarea className="research-textarea research-editor" value={draft}
            onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
            placeholder={"在此撰写章节正文（Markdown）。\n\n例如：\n## 3 方法\n本研究的核心是……"} spellCheck={false} />
          <p className="hint-text" style={{ marginTop: 8 }}>正文保存到项目目录的 manuscript 目录；导出 DOCX 时按顺序合并章节。</p>
        </div>
      </div>

      <div className="card">
        <div className="research-section-head"><h3>投稿材料</h3><span className="hint-text">DOCX 与 Cover Letter</span></div>
        <div className="research-grid2">
          <div className="research-dataset">
            <div className="research-section-head">
              <h3>导出 DOCX</h3>
              <span className="spacer" />
              <button type="button" className="button research-btn-sm" disabled={exporting} onClick={() => void handleExport()}>
                {exporting ? "导出中…" : "导出 DOCX"}
              </button>
            </div>
            <p className="hint-text">把已保存章节合并成 Word 文档，便于发给导师或按期刊模板二次排版。</p>
            {exportInfo !== null && (
              <div className="research-result">
                <span className="status status--ok">{describeExport(exportInfo)}</span>
                <span className="hint-text">{exportInfo.path}</span>
                <button type="button" className="button research-btn-sm" onClick={() => void copyText(exportInfo.path, "文件路径")}>复制路径</button>
              </div>
            )}
          </div>

          <div className="research-dataset">
            <div className="research-section-head">
              <h3>Cover Letter</h3>
              <span className="spacer" />
              <button type="button" className="button research-btn-sm" onClick={openCoverLetterInChat}>
                在主对话中生成
              </button>
            </div>
            <p className="hint-text">Cover Letter 在主聊天中生成（已预填指令并绑定本项目）；控制台只保留写作产物与导出。</p>
          </div>
        </div>
      </div>
    </div>
  );
}
