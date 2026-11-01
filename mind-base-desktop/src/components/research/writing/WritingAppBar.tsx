/**
 * 写作 tab 顶栏（Google Docs 风格）：56px 白底 + 底部细线。
 *
 * 左：文档图标 + 标题（点击重命名）+ 保存状态；右：文档选择 / 大纲 / 导入论文 /
 * 阅读 / 导出 ▾ / 保存。窄屏（compact）把导入与导出收进「更多」菜单。
 */

import { useEffect, useRef, useState } from "react";
import type { ManuscriptDocument } from "../../../lib/research";
import { kindLabel } from "./shared";

export interface WritingAppBarProps {
  doc: ManuscriptDocument | null;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  compact: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onImportPaper: () => void;
  importingPaper: boolean;
  onOpenReading: () => void;
  exporting: boolean;
  latexExporting: boolean;
  onExportWord: () => void;
  onExportLatex: () => void;
  onSave: () => void;
}

function DocGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h8l4.5 4.5V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5z" />
      <path d="M13.5 3.5V8.5h5" />
      <path d="M8 12h8M8 15.5h8M8 19h5" />
    </svg>
  );
}

function ListGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6.5h12M8 12h12M8 17.5h12" />
      <circle cx="4" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function OutlineGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  );
}

export default function WritingAppBar(props: WritingAppBarProps): React.JSX.Element {
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen && !moreOpen) return;
    function handleDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (exportRef.current !== null && !exportRef.current.contains(target)) setExportOpen(false);
      if (moreRef.current !== null && !moreRef.current.contains(target)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [exportOpen, moreOpen]);

  const saveState = props.saving ? "保存中…" : props.dirty ? "未保存" : "已保存";

  return (
    <header className="rs-ga">
      <div className="rs-ga__left">
        <span className="rs-ga__icon" aria-hidden="true"><DocGlyph /></span>
        {props.renaming ? (
          <input
            className="rs-ga__rename"
            value={props.renameDraft}
            aria-label="文档标题"
            onChange={(event) => props.onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onSaveRename();
              if (event.key === "Escape") props.onCancelRename();
            }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="rs-ga__title"
            title="点击重命名文档"
            onClick={() => { if (props.doc !== null) props.onStartRename(); }}
          >
            {props.doc?.title ?? "写作"}
          </button>
        )}
        {props.doc !== null && <span className="rs-ga__kind">{kindLabel(props.doc.kind)}</span>}
        <span className={props.dirty ? "rs-ga__state is-dirty" : "rs-ga__state"}>{saveState}</span>
      </div>

      <span className="spacer" />

      <div className="rs-ga__actions">
        <button
          type="button"
          className="rs-ga__iconbtn"
          aria-label="选择文档"
          title="选择文档"
          aria-expanded={props.pickerOpen}
          data-picker-toggle="true"
          onClick={props.onTogglePicker}
        >
          <ListGlyph />
        </button>

        <button
          type="button"
          className="rs-ga__iconbtn"
          aria-label="大纲"
          title="大纲"
          aria-pressed={props.outlineOpen}
          onClick={props.onToggleOutline}
        >
          <OutlineGlyph />
        </button>

        {!props.compact && (
          <>
            <button type="button" className="rs-ga__btn" disabled={props.importingPaper} onClick={props.onImportPaper}>
              {props.importingPaper ? "导入中…" : "导入论文"}
            </button>

            <div className="rs-ga__menu-anchor" ref={exportRef}>
              <button
                type="button"
                className="rs-ga__btn"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                disabled={props.doc === null || props.exporting || props.latexExporting}
                onClick={() => { setExportOpen((prev) => !prev); setMoreOpen(false); }}
              >
                {props.exporting || props.latexExporting ? "导出中…" : "导出 ▾"}
              </button>
              {exportOpen && (
                <div className="rs-ga__menu" role="menu">
                  <button type="button" role="menuitem" className="rs-ga__menuitem" disabled={props.exporting} onClick={() => { setExportOpen(false); props.onExportWord(); }}>
                    导出 Word（.docx）
                  </button>
                  <button type="button" role="menuitem" className="rs-ga__menuitem" disabled={props.latexExporting} onClick={() => { setExportOpen(false); props.onExportLatex(); }}>
                    导出 LaTeX（.tex + .bib）
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <button
          type="button"
          className="rs-ga__btn rs-ga__btn--read"
          disabled={props.doc === null}
          onClick={props.onOpenReading}
        >
          阅读
        </button>

        <button
          type="button"
          className="rs-ga__btn rs-ga__btn--filled"
          disabled={!props.canSave || props.saving}
          onClick={props.onSave}
        >
          {props.saving ? "保存中…" : "保存"}
        </button>

        {props.compact && (
          <div className="rs-ga__menu-anchor" ref={moreRef}>
            <button
              type="button"
              className="rs-ga__btn"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => { setMoreOpen((prev) => !prev); setExportOpen(false); }}
            >
              更多 ▾
            </button>
            {moreOpen && (
              <div className="rs-ga__menu" role="menu">
                <button type="button" role="menuitem" className="rs-ga__menuitem" disabled={props.importingPaper} onClick={() => { setMoreOpen(false); props.onImportPaper(); }}>
                  {props.importingPaper ? "导入中…" : "导入论文"}
                </button>
                <button type="button" role="menuitem" className="rs-ga__menuitem" disabled={props.doc === null || props.exporting} onClick={() => { setMoreOpen(false); props.onExportWord(); }}>
                  {props.exporting ? "导出 Word…" : "导出 Word（.docx）"}
                </button>
                <button type="button" role="menuitem" className="rs-ga__menuitem" disabled={props.doc === null || props.latexExporting} onClick={() => { setMoreOpen(false); props.onExportLatex(); }}>
                  {props.latexExporting ? "导出 LaTeX…" : "导出 LaTeX（.tex + .bib）"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
