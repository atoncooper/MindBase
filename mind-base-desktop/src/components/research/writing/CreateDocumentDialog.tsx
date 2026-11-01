/**
 * 新建写作文档弹窗：类型卡片（显示默认章节数）+ 标题 + 默认章节预览。
 */

import { useState } from "react";
import {
  MANUSCRIPT_DOCUMENT_KINDS, MANUSCRIPT_DOCUMENT_KIND_LABELS,
  type ManuscriptDocumentKind,
} from "../../../lib/research";
import { defaultSections } from "./shared";

export interface CreateDocumentDialogProps {
  creating: boolean;
  onCreate: (kind: ManuscriptDocumentKind, title: string) => Promise<boolean>;
  onClose: () => void;
}

export default function CreateDocumentDialog(props: CreateDocumentDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<ManuscriptDocumentKind>("proposal");
  const [title, setTitle] = useState("开题报告");
  const [localError, setLocalError] = useState<string | null>(null);

  const sections = defaultSections(kind);

  function changeKind(next: ManuscriptDocumentKind): void {
    const previousLabel = MANUSCRIPT_DOCUMENT_KIND_LABELS[kind] ?? "";
    const nextLabel = MANUSCRIPT_DOCUMENT_KIND_LABELS[next] ?? "";
    setTitle((prev) => (prev.trim() === "" || prev === previousLabel ? nextLabel : prev));
    setKind(next);
    setLocalError(null);
  }

  async function submit(): Promise<void> {
    if (props.creating) return;
    if (title.trim() === "") {
      setLocalError("请填写文档标题");
      return;
    }
    setLocalError(null);
    const ok = await props.onCreate(kind, title);
    if (ok) props.onClose();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div className="modal rs-doccreate" role="dialog" aria-modal="true" aria-labelledby="rs-doc-create-title">
        <div className="modal__head">
          <h3 className="modal__title" id="rs-doc-create-title">新建文档</h3>
          <button type="button" className="icon-button" aria-label="关闭" onClick={props.onClose}>×</button>
        </div>
        <p className="hint-text">先选文档类型：类型决定默认章节，创建后可增删章节、重命名或导出。</p>

        <div className="rs-doccreate__kinds" role="radiogroup" aria-label="文档类型">
          {MANUSCRIPT_DOCUMENT_KINDS.map((item) => {
            const active = item.value === kind;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={active ? "rs-doccreate__kind is-active" : "rs-doccreate__kind"}
                onClick={() => changeKind(item.value)}
              >
                <span className="rs-doccreate__kind-name">{item.label}</span>
                <span className="rs-doccreate__kind-meta">{defaultSections(item.value).length + " 个默认章节"}</span>
              </button>
            );
          })}
        </div>

        <div className="research-form rs-doccreate__form">
          <div className="research-field">
            <label htmlFor="rs-doc-title">文档标题</label>
            <input
              id="rs-doc-title"
              className="text-input"
              placeholder="例如：开题报告（2026 春）"
              value={title}
              disabled={props.creating}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
              autoFocus
            />
          </div>
          <div className="research-field">
            <label>默认章节（{sections.length} 个）</label>
            <div className="rs-doc-modal__sections">
              {sections.map((section, index) => (
                <span key={section} className="rs-doc-modal__section">{index + 1}. {section}</span>
              ))}
            </div>
          </div>
          {localError !== null && <p className="error-text" style={{ margin: 0 }}>{localError}</p>}
        </div>

        <div className="research-actions">
          <button type="button" className="button" onClick={props.onClose} disabled={props.creating}>取消</button>
          <button type="button" className="button button--primary" onClick={() => void submit()} disabled={props.creating}>
            {props.creating ? "创建中…" : "创建文档"}
          </button>
        </div>
      </div>
    </div>
  );
}
