/**
 * 大纲抽屉（右侧覆盖）：章节进度 + 目录跳转 + 新增/删除章节 + AI 动作。
 */

import { useState } from "react";
import type { ManuscriptSection } from "../../../lib/research";
import { STATUS_LABEL, textLength, type WritingAiAction } from "./shared";

export interface OutlineDrawerProps {
  rows: ManuscriptSection[];
  selectedSection: string;
  draft: string;
  dirty: boolean;
  adding: boolean;
  onClose: () => void;
  onSelect: (section: string) => void;
  onAddSection: (name: string) => Promise<boolean>;
  onDeleteSection: () => void;
  onAiAction: (action: WritingAiAction) => void;
}

export default function OutlineDrawer(props: OutlineDrawerProps): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const total = props.rows.length;
  const written = props.rows.filter((row) => {
    if (row.section === props.selectedSection) return row.words > 0 || props.draft.trim() !== "";
    return row.words > 0;
  }).length;
  const percent = total === 0 ? 0 : Math.round((written / total) * 100);
  const selectedRow = props.rows.find((row) => row.section === props.selectedSection);

  async function submitAdd(): Promise<void> {
    const name = nameDraft.trim();
    if (name === "" || props.adding) return;
    const ok = await props.onAddSection(name);
    if (ok) {
      setNameDraft("");
      setAddOpen(false);
    }
  }

  function jumpTo(section: string, index: number): void {
    props.onSelect(section);
    const node = document.getElementById("rs-gd-sec-" + index);
    if (node !== null) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="rs-odrawer" role="dialog" aria-label="大纲">
      <button type="button" className="rs-odrawer__scrim" aria-label="关闭大纲" onClick={props.onClose} />
      <aside className="rs-odrawer__panel">
        <header className="rs-odrawer__head">
          <h2 className="rs-odrawer__title">大纲</h2>
          <span className="hint-text">{written + "/" + total + " 已写"}</span>
          <span className="spacer" />
          <button type="button" className="rs-odrawer__close" aria-label="关闭大纲" onClick={props.onClose}>×</button>
        </header>

        <div className="rs-progress" aria-hidden="true">
          <span className="rs-progress__bar" style={{ width: percent + "%" }} />
        </div>

        {total === 0 ? (
          <p className="hint-text">这篇文档还没有章节，先新增第一节。</p>
        ) : (
          <nav className="rs-odrawer__list" aria-label="章节目录">
            {props.rows.map((row, index) => {
              const current = row.section === props.selectedSection;
              const liveWords = current && props.dirty ? textLength(props.draft) : row.words;
              return (
                <button
                  key={row.id === "" ? row.section : row.id}
                  type="button"
                  className={current ? "rs-odrawer__item is-current" : "rs-odrawer__item"}
                  onClick={() => jumpTo(row.section, index)}
                >
                  <span className="rs-odrawer__index">{index + 1}</span>
                  <span className="rs-odrawer__body">
                    <span className="rs-odrawer__name">{row.section}</span>
                    <span className="rs-odrawer__meta">
                      {(liveWords > 0 ? liveWords + " 字" : "未写") + " · " + (STATUS_LABEL[row.status] ?? row.status)}
                    </span>
                  </span>
                  <span className={liveWords > 0 ? "rs-odrawer__dot is-written" : "rs-odrawer__dot"} aria-hidden="true" />
                </button>
              );
            })}
          </nav>
        )}

        <div className="rs-odrawer__add">
          {addOpen ? (
            <>
              <input
                className="rs-odrawer__input"
                placeholder="新章节名称"
                aria-label="新章节名称"
                value={nameDraft}
                disabled={props.adding}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitAdd();
                  if (event.key === "Escape") { setAddOpen(false); setNameDraft(""); }
                }}
                autoFocus
              />
              <button type="button" className="rs-ga__btn" disabled={props.adding} onClick={() => void submitAdd()}>
                {props.adding ? "新增中…" : "添加"}
              </button>
            </>
          ) : (
            <button type="button" className="rs-odrawer__addbtn" onClick={() => setAddOpen(true)}>＋ 新增章节</button>
          )}
          <button
            type="button"
            className="rs-odrawer__dangers"
            disabled={selectedRow === undefined}
            onClick={props.onDeleteSection}
          >
            删除当前章节
          </button>
        </div>

        <section className="rs-odrawer__ai">
          <p className="rs-odrawer__ai-title">AI 动作</p>
          <div className="rs-odrawer__ai-buttons">
            <button type="button" className="rs-ga__btn" disabled={props.selectedSection === ""} onClick={() => props.onAiAction("continue")}>
              AI 续写本节
            </button>
            <button type="button" className="rs-ga__btn" disabled={props.selectedSection === ""} onClick={() => props.onAiAction("polish")}>
              AI 润色
            </button>
            <button type="button" className="rs-ga__btn" disabled={props.selectedSection === ""} onClick={() => props.onAiAction("cite")}>
              AI 检查引用
            </button>
          </div>
          <p className="hint-text">AI 动作在主聊天执行（已绑定本项目与当前章节）。</p>
        </section>
      </aside>
    </div>
  );
}
