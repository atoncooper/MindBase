/**
 * 写作 tab（Google Docs 风格）：顶栏 + 只读全文画布 + 文档选择 popover +
 * 大纲抽屉 + 全屏阅读（阅读内可编辑）。
 *
 * 本文件只做状态与编排：文档/章节 CRUD、dirty 确认、保存（Ctrl/⌘+S）、导入论文、
 * 导出、AI 跳转、阅读模式与 onDirtyChange。
 */

import { useEffect, useMemo, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../lib/toast";
import {
  createManuscriptDocument, deleteManuscript, deleteManuscriptDocument, exportDocx, exportLatex,
  importResearchPaper, listManuscript, listManuscriptDocuments, saveManuscript, updateManuscriptDocument,
  type DocxExport, type LatexExport, type ManuscriptDocument, type ManuscriptDocumentKind,
  type ManuscriptSection,
} from "../../lib/research";
import { copyToClipboard, errorText } from "./common";
import { HOME_HASH, navigate } from "../../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../../lib/chat";
import { setActiveResearchProject, setPendingResearchPrompt, setResearchNewChatFlag } from "../../lib/research-context";
import CreateDocumentDialog from "./writing/CreateDocumentDialog";
import DocumentPicker from "./writing/DocumentPicker";
import ExportBar from "./writing/ExportBar";
import OutlineDrawer from "./writing/OutlineDrawer";
import ReadPage from "./writing/ReadPage";
import ReadingMode from "./writing/ReadingMode";
import WritingAppBar from "./writing/WritingAppBar";
import { useMediaQuery } from "./writing/hooks";
import { defaultSections, kindLabel, type WritingAiAction } from "./writing/shared";

export default function WritingTab({
  projectId, onDirtyChange,
}: { projectId: string; onDirtyChange?: (dirty: boolean) => void }): React.JSX.Element {
  const toast = useToast();
  // 文档层
  const [documents, setDocuments] = useState<ManuscriptDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [docBusy, setDocBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importingPaper, setImportingPaper] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // 章节层
  const [rows, setRows] = useState<ManuscriptSection[]>([]);
  const [selectedSection, setSelectedSection] = useState("");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loadingSections, setLoadingSections] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sectionBusy, setSectionBusy] = useState(false);
  // 布局 / 阅读
  const [pickerOpen, setPickerOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const compact = useMediaQuery("(max-width: 1100px)");
  // 导出 + 提示
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState<DocxExport | null>(null);
  const [latexExporting, setLatexExporting] = useState(false);
  const [latexInfo, setLatexInfo] = useState<LatexExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingDocs(true);
    listManuscriptDocuments(projectId)
      .then((docs) => {
        if (cancelled) return;
        setDocuments(docs);
        setSelectedDocId((prev) => (prev !== null && docs.some((doc) => doc.id === prev) ? prev : docs[0]?.id ?? null));
      })
      .catch((err) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoadingDocs(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (selectedDocId === null) {
      setRows([]); setSelectedSection(""); setDraft(""); setDirty(false);
      return;
    }
    let cancelled = false;
    setLoadingSections(true);
    setRows([]); setSelectedSection(""); setDraft(""); setDirty(false);
    listManuscript(projectId, selectedDocId)
      .then((loaded) => {
        if (cancelled) return;
        setRows(loaded);
        const byOrder = [...loaded].sort((a, b) => a.ord - b.ord);
        const initial = byOrder.find((row) => row.words > 0)?.section ?? byOrder[0]?.section ?? "";
        setSelectedSection(initial);
        setDraft(loaded.find((row) => row.section === initial)?.content ?? "");
      })
      .catch((err) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoadingSections(false); });
    return () => { cancelled = true; };
  }, [projectId, selectedDocId]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const selectedDoc = documents.find((doc) => doc.id === selectedDocId) ?? null;
  const ordered = useMemo<ManuscriptSection[]>(() => [...rows].sort((a, b) => a.ord - b.ord), [rows]);
  const selectedRow = rows.find((row) => row.section === selectedSection);

  /** 重新拉文档列表；preferId 优先保留当前选中。 */
  async function refreshDocuments(preferId?: string): Promise<void> {
    try {
      const docs = await listManuscriptDocuments(projectId);
      setDocuments(docs);
      const preferred = preferId ?? selectedDocId;
      setSelectedDocId(preferred !== null && docs.some((doc) => doc.id === preferred) ? preferred : docs[0]?.id ?? null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function selectDocument(documentId: string): Promise<void> {
    if (documentId === selectedDocId) return;
    if (dirty) {
      const confirmed = await confirm("当前章节有未保存的改动，切换文档会丢弃这些改动。继续？", { title: "未保存的改动", kind: "warning" });
      if (!confirmed) return;
    }
    setSelectedDocId(documentId);
    setRenaming(false);
    setError(null); setNotice(null); setDirty(false);
    setExportInfo(null); setLatexInfo(null);
  }

  /** 新建文档（弹窗回调）：成功返回 true，由弹窗决定是否关闭。 */
  async function handleCreateDocument(kind: ManuscriptDocumentKind, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (trimmed === "") { setError("请填写文档标题"); return false; }
    if (dirty) {
      const confirmed = await confirm("当前章节有未保存的改动，新建并切换文档会丢弃这些改动。继续？", { title: "未保存的改动", kind: "warning" });
      if (!confirmed) return false;
    }
    const sections = defaultSections(kind);
    setCreating(true); setError(null); setNotice(null);
    try {
      const created = await createManuscriptDocument(projectId, kind, trimmed, sections);
      setShowCreate(false);
      setDirty(false);
      setExportInfo(null); setLatexInfo(null);
      await refreshDocuments(created.id);
      setNotice("已创建「" + kindLabel(created.kind) + "」文档「" + created.title + "」，含 " + sections.length + " 个默认章节");
      toast.success("文档已创建", { title: "写作" });
      return true;
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "新建文档失败" });
      return false;
    } finally {
      setCreating(false);
    }
  }

  /** 导入已有论文（MD/TXT/TEX/DOCX/PDF/HTML）为新的写作文档，并选中它。 */
  async function handleImportPaper(): Promise<void> {
    const selected = await open({
      multiple: false,
      title: "导入已有论文",
      filters: [{ name: "论文文件", extensions: ["md", "markdown", "txt", "tex", "latex", "docx", "pdf", "html", "htm"] }],
    });
    const source = (Array.isArray(selected) ? selected[0] : selected) ?? null;
    if (source === null || source === "") return;
    if (dirty) {
      const confirmed = await confirm("当前章节有未保存的改动，导入论文并切换文档会丢弃这些改动。继续？", { title: "未保存的改动", kind: "warning" });
      if (!confirmed) return;
    }
    setImportingPaper(true); setError(null); setNotice(null);
    try {
      const imported = await importResearchPaper(projectId, source);
      setDirty(false);
      setExportInfo(null); setLatexInfo(null);
      await refreshDocuments(imported.documentId);
      const refs = imported.referencesImported ?? 0;
      setNotice(
        "已导入论文「" + imported.title + "」，拆分 " + imported.sections.length + " 节" +
        (refs > 0 ? "，自动解析 " + refs + " 条参考文献（待核验）" : "") +
        "；原文件复制到 " + imported.copiedPath,
      );
      toast.success(
        "已导入「" + imported.title + "」（" + imported.sections.length + " 节" + (refs > 0 ? " · " + refs + " 条文献" : "") + "）",
        { title: "导入论文" },
      );
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "导入论文失败" });
    } finally {
      setImportingPaper(false);
    }
  }

  function startRename(): void {
    if (selectedDoc === null) return;
    setRenameDraft(selectedDoc.title);
    setRenaming(true);
    setError(null); setNotice(null);
  }

  async function saveRename(): Promise<void> {
    if (selectedDoc === null || docBusy) return;
    const title = renameDraft.trim();
    if (title === "") { setError("文档标题不能为空"); return; }
    setDocBusy(true); setError(null);
    try {
      await updateManuscriptDocument(projectId, selectedDoc.id, title);
      setRenaming(false);
      await refreshDocuments(selectedDoc.id);
      setNotice("文档已重命名为「" + title + "」");
      toast.success("文档已重命名", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "重命名失败" }); }
    finally { setDocBusy(false); }
  }

  async function handleDeleteDocument(): Promise<void> {
    if (selectedDoc === null || docBusy) return;
    const confirmed = await confirm(
      "删除文档「" + selectedDoc.title + "」及其 " + selectedDoc.sectionCount + " 个章节？该操作不可恢复。",
      { title: "删除文档", kind: "warning" },
    );
    if (!confirmed) return;
    setDocBusy(true); setError(null); setNotice(null);
    try {
      await deleteManuscriptDocument(projectId, selectedDoc.id);
      setDirty(false); setRenaming(false);
      setExportInfo(null); setLatexInfo(null);
      await refreshDocuments();
      setNotice("已删除文档「" + selectedDoc.title + "」");
      toast.success("文档已删除", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "删除文档失败" }); }
    finally { setDocBusy(false); }
  }

  async function handleSelectSection(section: string): Promise<void> {
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
    if (selectedDocId === null || selectedSection === "" || saving) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = await saveManuscript(projectId, selectedDocId, selectedSection, draft);
      setRows((prev) => [...prev.filter((row) => row.section !== saved.section), saved]);
      if (typeof saved.content === "string") setDraft(saved.content);
      setDirty(false);
      setNotice("「" + saved.section + "」已保存（" + saved.words + " 字）");
      toast.success("章节已保存", { title: "写作" });
      void refreshDocuments(selectedDocId);
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "保存失败" }); }
    finally { setSaving(false); }
  }

  async function handleDeleteSection(): Promise<void> {
    if (selectedDocId === null || selectedSection === "") return;
    if (selectedRow === undefined) { setNotice("该章节还没有保存过正文，无需删除"); return; }
    const confirmed = await confirm(
      "删除章节「" + selectedSection + "」（" + selectedRow.words + " 字）？该操作不可恢复。",
      { title: "删除章节", kind: "warning" },
    );
    if (!confirmed) return;
    setError(null);
    try {
      await deleteManuscript(projectId, selectedDocId, selectedSection);
      const remaining = rows.filter((row) => row.section !== selectedSection);
      const next = [...remaining].sort((a, b) => a.ord - b.ord)[0]?.section ?? "";
      setRows(remaining);
      setSelectedSection(next);
      setDraft(remaining.find((row) => row.section === next)?.content ?? "");
      setDirty(false);
      setOutlineOpen(false);
      setNotice("已删除「" + selectedSection + "」");
      toast.success("章节已删除", { title: "写作" });
      void refreshDocuments(selectedDocId);
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "删除失败" }); }
  }

  /** 新增章节（大纲回调）：成功返回 true。 */
  async function handleAddSection(name: string): Promise<boolean> {
    if (selectedDocId === null) { setError("请先新建或选择文档"); return false; }
    const section = name.trim();
    if (section === "") { setError("请填写章节名称"); return false; }
    if (rows.some((row) => row.section === section)) { setError("章节「" + section + "」已存在"); return false; }
    setSectionBusy(true); setError(null); setNotice(null);
    try {
      const saved = await saveManuscript(projectId, selectedDocId, section, "");
      setRows((prev) => [...prev, saved]);
      setSelectedSection(saved.section);
      setDraft(saved.content ?? "");
      setDirty(false);
      setNotice("已新增章节「" + saved.section + "」");
      toast.success("章节已新增", { title: "写作" });
      void refreshDocuments(selectedDocId);
      return true;
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "新增章节失败" });
      return false;
    } finally {
      setSectionBusy(false);
    }
  }

  async function handleExport(): Promise<void> {
    if (selectedDocId === null) { setError("请先选择文档"); return; }
    setExporting(true); setError(null);
    try {
      const info = await exportDocx(projectId, selectedDocId);
      setExportInfo(info);
      toast.success("Word 已导出", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "导出失败" }); }
    finally { setExporting(false); }
  }

  async function handleExportLatex(): Promise<void> {
    if (selectedDocId === null) { setError("请先选择文档"); return; }
    setLatexExporting(true); setError(null);
    try {
      const info = await exportLatex(projectId, selectedDocId);
      setLatexInfo(info);
      toast.success("LaTeX 已导出", { title: "写作" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "导出失败" }); }
    finally { setLatexExporting(false); }
  }

  /** 写作相关 AI 都在主聊天生成：绑定项目 + 预填指令 + 跳转。 */
  function jumpToChat(prompt: string): void {
    setActiveResearchProject(projectId);
    setPendingResearchPrompt(prompt);
    setResearchNewChatFlag();
    window.sessionStorage.setItem(CHAT_MODE_JUMP_KEY, "chat");
    navigate(HOME_HASH);
  }

  function sectionLocation(): string {
    return selectedDoc === null ? selectedSection : selectedDoc.title + " · " + selectedSection;
  }

  /** 「让 AI 写本节」：把当前文档 + 章节带进预填提示词。 */
  function openSectionDraftInChat(): void {
    if (selectedSection === "") return;
    jumpToChat(
      "请基于项目简报与证据，为「" + sectionLocation() + "」章节写初稿（Markdown + LaTeX 公式），写入后导出 Word 与 LaTeX。",
    );
  }

  /** AI 动作：续写 / 润色 / 检查引用。 */
  function handleAiAction(action: WritingAiAction): void {
    if (selectedSection === "") return;
    const location = sectionLocation();
    if (action === "continue") {
      jumpToChat("请基于「" + location + "」已有正文继续往下写，保持学术语气与 Markdown + LaTeX 公式约定，并说明新增内容的依据；写完后保存该章节。");
    } else if (action === "polish") {
      jumpToChat("请润色「" + location + "」章节正文：保持事实与数字不变，改善逻辑衔接、学术表达与格式（Markdown + LaTeX），写回该章节并保存。");
    } else {
      jumpToChat("请检查「" + location + "」章节的引用：找出需要文献支撑但未标注的论断，结合项目里已核验的文献给出引用建议，并指出可能不存在的引用。");
    }
  }

  async function copyText(label: string, text: string): Promise<void> {
    const ok = await copyToClipboard(text);
    if (ok) toast.success("已复制" + label, { title: "写作" });
    else setError("复制" + label + "失败：请手动选中复制");
  }

  // Ctrl/⌘ + S：阅读浮层内由 ReadingMode 自行处理，这里只在主界面保存。
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if (reading || !dirty || selectedDocId === null || selectedSection === "" || saving) return;
      event.preventDefault();
      void handleSave();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, dirty, selectedDocId, selectedSection, saving, draft, projectId]);

  const canSave = dirty && selectedSection !== "" && selectedDocId !== null;

  return (
    <div className="rs-pane rs-gd">
      {error !== null && <p className="error-text rs-gd__banner" onClick={() => setError(null)}>{error}</p>}
      {notice !== null && <p className="hint-text rs-gd__banner" onClick={() => setNotice(null)}>{notice}</p>}

      <div className="rs-gd__shell">
        <WritingAppBar
          doc={selectedDoc}
          dirty={dirty}
          saving={saving}
          canSave={canSave}
          compact={compact}
          renaming={renaming}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onStartRename={startRename}
          onSaveRename={() => { void saveRename(); }}
          onCancelRename={() => setRenaming(false)}
          pickerOpen={pickerOpen}
          onTogglePicker={() => { setPickerOpen((prev) => !prev); setOutlineOpen(false); }}
          outlineOpen={outlineOpen}
          onToggleOutline={() => { setOutlineOpen((prev) => !prev); setPickerOpen(false); }}
          onImportPaper={() => { void handleImportPaper(); }}
          importingPaper={importingPaper}
          onOpenReading={() => { if (selectedDoc !== null) { setPickerOpen(false); setOutlineOpen(false); setReading(true); } }}
          exporting={exporting}
          latexExporting={latexExporting}
          onExportWord={() => { void handleExport(); }}
          onExportLatex={() => { void handleExportLatex(); }}
          onSave={() => { void handleSave(); }}
        />

        {(exportInfo !== null || latexInfo !== null) && (
          <ExportBar
            wordInfo={exportInfo}
            latexInfo={latexInfo}
            onCopy={(label, text) => { void copyText(label, text); }}
            onClose={() => { setExportInfo(null); setLatexInfo(null); }}
          />
        )}

        <ReadPage
          projectId={projectId}
          document={selectedDoc}
          rows={ordered}
          selectedSection={selectedSection}
          draft={draft}
          dirty={dirty}
          loading={loadingDocs || loadingSections}
          onNewDocument={() => setShowCreate(true)}
        />
      </div>

      {pickerOpen && (
        <DocumentPicker
          documents={documents}
          selectedId={selectedDocId}
          dirty={dirty}
          loading={loadingDocs}
          busy={docBusy}
          renaming={renaming}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onSelect={(documentId) => { void selectDocument(documentId); }}
          onStartRename={startRename}
          onSaveRename={() => { void saveRename(); }}
          onCancelRename={() => setRenaming(false)}
          onDelete={() => { void handleDeleteDocument(); }}
          onNewDocument={() => { setPickerOpen(false); setShowCreate(true); }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {outlineOpen && (
        <OutlineDrawer
          rows={ordered}
          selectedSection={selectedSection}
          draft={draft}
          dirty={dirty}
          adding={sectionBusy}
          onClose={() => setOutlineOpen(false)}
          onSelect={(section) => { void handleSelectSection(section); }}
          onAddSection={handleAddSection}
          onDeleteSection={() => { void handleDeleteSection(); }}
          onAiAction={handleAiAction}
        />
      )}

      {showCreate && (
        <CreateDocumentDialog
          creating={creating}
          onCreate={handleCreateDocument}
          onClose={() => setShowCreate(false)}
        />
      )}

      {reading && selectedDoc !== null && (
        <ReadingMode
          projectId={projectId}
          document={selectedDoc}
          rows={ordered}
          selectedSection={selectedSection}
          draft={draft}
          dirty={dirty}
          saving={saving}
          onClose={() => setReading(false)}
          onSelectSection={(section) => { void handleSelectSection(section); }}
          onChange={(value) => { setDraft(value); setDirty(true); }}
          onSave={() => { void handleSave(); }}
          onAskAiSection={openSectionDraftInChat}
        />
      )}
    </div>
  );
}
