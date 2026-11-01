/**
 * 阅读模式（全屏）：默认阅读整篇文档；顶栏「编辑」进入编辑态，
 * 左侧目录保留、右侧显示当前章节 textarea（保存 / 完成 / Ctrl+S）。
 *
 * 退出阅读或完成编辑时若有未保存改动，会先 confirm；Esc 在阅读态退出、编辑态完成。
 * 当前选中章节若有未保存修改（dirty），正文用传入的 draft 代替已保存内容。
 */

import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { ManuscriptDocument, ManuscriptSection } from "../../../lib/research";
import { MarkdownContent } from "../../chat/MarkdownContent";
import { kindLabel, paragraphCount, textLength } from "./shared";
import SourceViewer, { sourceKindOf } from "./SourceViewer";

export interface ReadingModeProps {
  projectId: string;
  document: ManuscriptDocument;
  /** 已按 ord 排序的全部章节（含 content）。 */
  rows: ManuscriptSection[];
  selectedSection: string;
  draft: string;
  dirty: boolean;
  saving: boolean;
  onClose: () => void;
  onSelectSection: (section: string) => void;
  onChange: (value: string) => void;
  onSave: () => void;
  onAskAiSection: () => void;
}

export default function ReadingMode(props: ReadingModeProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const initialSection = props.rows.some((row) => row.section === props.selectedSection)
    ? props.selectedSection
    : props.rows[0]?.section ?? "";
  const [activeSection, setActiveSection] = useState(initialSection);
  const [editing, setEditing] = useState(false);
  // 导入的 docx/pdf 默认原始文档；普通文档只有文本视图。
  const sourcePath = typeof props.document.sourcePath === "string" ? props.document.sourcePath : "";
  const hasSource = sourcePath !== "";
  const canOriginal = hasSource && sourceKindOf(sourcePath) !== "other";
  const [viewMode, setViewMode] = useState<"source" | "text">(canOriginal ? "source" : "text");
  // 原生渲染失败：切文本视图并提示，可重试。
  const [sourceError, setSourceError] = useState<string | null>(null);

  const sections = props.rows.map((row) => {
    const content = row.section === props.selectedSection && props.dirty ? props.draft : row.content;
    return { row, content, words: textLength(content) };
  });
  const totalWords = sections.reduce((sum, item) => sum + item.words, 0);
  const activeIndex = Math.max(0, sections.findIndex((item) => item.row.section === activeSection));
  const total = sections.length;

  // 打开时定位到当前编辑章节。
  useEffect(() => {
    const node = sectionRefs.current.get(initialSection);
    if (node !== undefined) node.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function requestClose(): void {
    if (!props.dirty) { props.onClose(); return; }
    void confirm("有未保存的改动，仍要退出阅读模式吗？（退出后改动仍保留在编辑器中，可稍后保存）", { title: "未保存的改动", kind: "warning" })
      .then((ok) => { if (ok) props.onClose(); });
  }

  function requestFinish(): void {
    if (!props.dirty) { setEditing(false); return; }
    void confirm("有未保存的改动，仍要完成编辑吗？（未保存内容会保留在阅读视图，可稍后保存）", { title: "未保存的改动", kind: "warning" })
      .then((ok) => { if (ok) setEditing(false); });
  }

  // Esc / Ctrl+S：阅读态 Esc 退出，编辑态 Esc 完成、Ctrl+S 保存。
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (editing) {
          event.preventDefault();
          if (props.dirty && !props.saving) props.onSave();
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (editing) requestFinish();
      else requestClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, props.dirty, props.saving, props.onSave, props.onClose]);

  /** 滚动时按「最后一个越过阅读线」的章节更新目录高亮。 */
  function handleScroll(): void {
    const container = scrollRef.current;
    if (container === null || sections.length === 0) return;
    const line = container.getBoundingClientRect().top + 120;
    let current = sections[0].row.section;
    for (const item of sections) {
      const node = sectionRefs.current.get(item.row.section);
      if (node !== undefined && node.getBoundingClientRect().top <= line) current = item.row.section;
    }
    setActiveSection((prev) => (prev === current ? prev : current));
  }

  function jumpTo(section: string): void {
    const node = sectionRefs.current.get(section);
    if (node === undefined) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(section);
  }

  function setSectionRef(section: string, node: HTMLElement | null): void {
    if (node === null) sectionRefs.current.delete(section);
    else sectionRefs.current.set(section, node);
  }

  function tocButton(item: { row: ManuscriptSection; words: number }, index: number, active: boolean): React.JSX.Element {
    return (
      <button
        key={item.row.id === "" ? item.row.section : item.row.id}
        type="button"
        className={active ? "rs-reading2__tocitem is-active" : "rs-reading2__tocitem"}
        onClick={() => {
          if (editing) {
            props.onSelectSection(item.row.section);
            setActiveSection(item.row.section);
          } else {
            jumpTo(item.row.section);
          }
        }}
      >
        <span className="rs-reading2__tocindex">{index + 1}</span>
        <span className="rs-reading2__tocbody">
          <span className="rs-reading2__tocname">{item.row.section}</span>
          <span className="rs-reading2__tocwords">{item.words > 0 ? item.words + " 字" : "未写"}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="rs-reading2" role="dialog" aria-modal="true" aria-label={editing ? "阅读编辑" : "阅读模式"}>
      <header className="rs-reading2__bar">
        <div className="rs-reading2__titleinfo">
          <h2 className="rs-reading2__title">{props.document.title}</h2>
          <span className="rs-doc-badge">{kindLabel(props.document.kind)}</span>
          <span className="hint-text">
            {editing
              ? "编辑 · " + (props.selectedSection === "" ? "未选择章节" : props.selectedSection)
              : viewMode === "source" && canOriginal
                ? (sourcePath.split("/").pop() ?? sourcePath) + " · 原始文档"
                : "共 " + total + " 节 · " + totalWords + " 字" + (total > 0 ? " · 第 " + (activeIndex + 1) + " / " + total + " 节" : "")}
          </span>
        </div>
        <span className="spacer" />
        {!editing && hasSource && (
          <div className="rs-gd__viewtoggle" role="group" aria-label="视图模式">
            <button
              type="button"
              className={viewMode === "source" ? "is-active" : undefined}
              aria-pressed={viewMode === "source"}
              onClick={() => { setSourceError(null); setViewMode("source"); }}
            >
              原始文档
            </button>
            <button
              type="button"
              className={viewMode === "text" ? "is-active" : undefined}
              aria-pressed={viewMode === "text"}
              onClick={() => { setSourceError(null); setViewMode("text"); }}
            >
              文本视图
            </button>
          </div>
        )}
        {editing ? (
          <>
            <button type="button" className="button research-btn-sm" disabled={props.selectedSection === ""} onClick={props.onAskAiSection}>
              让 AI 写本节
            </button>
            <button
              type="button"
              className="button button--primary research-btn-sm"
              disabled={!props.dirty || props.saving}
              onClick={props.onSave}
            >
              {props.saving ? "保存中…" : "保存"}
            </button>
            <button type="button" className="button research-btn-sm" onClick={() => void requestFinish()}>
              完成
            </button>
          </>
        ) : (
          <button type="button" className="button research-btn-sm" onClick={() => setEditing(true)}>
            编辑
          </button>
        )}
        <button type="button" className="button research-btn-sm" onClick={() => requestClose()}>
          退出阅读
        </button>
      </header>

      <div className="rs-reading2__progress" aria-hidden="true">
        <span className="rs-reading2__progressbar" style={{ width: (total === 0 ? 0 : Math.round(((activeIndex + 1) / total) * 100)) + "%" }} />
      </div>

      {sourceError !== null && hasSource && !editing && (
        <div className="rs-reading2__sourceerr">
          <span className="hint-text">{"原始文档渲染失败，已切换文本视图：" + sourceError}</span>
          <button
            type="button"
            className="rs-ga__btn"
            onClick={() => { setSourceError(null); setViewMode("source"); }}
          >
            重试原始文档
          </button>
        </div>
      )}

      <div className="rs-reading2__body">
        {!editing && hasSource && viewMode === "source" ? (
          <div className="rs-reading2__scroll">
            <div className="rs-reading2__sourcewrap">
              <SourceViewer
                projectId={props.projectId}
                path={sourcePath}
                onError={(message) => { setSourceError(message); setViewMode("text"); }}
              />
            </div>
          </div>
        ) : (
          <>
        <aside className="rs-reading2__toc" aria-label="文章目录">
          <p className="rs-reading2__toc-title">目录</p>
          {total === 0 ? (
            <p className="hint-text">本文档还没有章节。</p>
          ) : (
            <nav className="rs-reading2__toc-list">
              {sections.map((item, index) =>
                tocButton(item, index, item.row.section === (editing ? props.selectedSection : activeSection)),
              )}
            </nav>
          )}
        </aside>

        {editing ? (
          <div className="rs-reading2__editscroll">
            {props.selectedSection === "" ? (
              <p className="hint-text rs-reading2__editempty">从左侧目录选择要编辑的章节。</p>
            ) : (
              <div className="rs-reading2__editpaper">
                <div className="rs-reading2__edithead">
                  <span className="rs-reading2__editsection">{props.selectedSection}</span>
                  <span className="hint-text">
                    {textLength(props.draft) + " 字 · " + paragraphCount(props.draft) + " 段" + (props.dirty ? " · 未保存" : "")}
                  </span>
                  <span className="spacer" />
                  <span className="hint-text">Ctrl/⌘ + S 保存</span>
                </div>
                <textarea
                  className="rs-reading2__editinput"
                  value={props.draft}
                  onChange={(event) => props.onChange(event.target.value)}
                  placeholder="在此编辑本章节正文（Markdown + LaTeX 数学，如 $E=mc^2$）"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="rs-reading2__scroll" ref={scrollRef} onScroll={handleScroll}>
            <article className="rs-reading2__article">
              <header className="rs-reading2__dochead">
                <h1>{props.document.title}</h1>
                <p className="rs-reading2__docmeta">
                  {kindLabel(props.document.kind) + " · " + total + " 节 · " + totalWords + " 字"}
                  {props.dirty ? " · 含未保存修改" : ""}
                </p>
              </header>

              {total === 0 ? (
                <p className="hint-text">本文档还没有章节，先在大纲新增章节后再进入阅读模式。</p>
              ) : (
                sections.map((item, index) => (
                  <section
                    key={item.row.id === "" ? item.row.section : item.row.id}
                    ref={(node) => { setSectionRef(item.row.section, node); }}
                    className="rs-reading2__section"
                  >
                    <h2 className="rs-reading2__sectiontitle">
                      <span className="rs-reading2__sectionnum">{index + 1}</span>
                      {item.row.section}
                    </h2>
                    {item.content.trim() === "" ? (
                      <p className="hint-text rs-reading2__empty">（本节暂无正文）</p>
                    ) : (
                      <MarkdownContent content={item.content} />
                    )}
                  </section>
                ))
              )}
            </article>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
