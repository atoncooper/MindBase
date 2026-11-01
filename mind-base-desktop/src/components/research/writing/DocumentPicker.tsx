/**
 * 文档选择 popover（替代常驻左栏）：搜索 + 类型筛选 chips + 列表 +
 * 新建 / 重命名 / 删除。点外部或 Esc 关闭。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MANUSCRIPT_DOCUMENT_KINDS, type ManuscriptDocument,
} from "../../../lib/research";
import { formatDate } from "../common";
import { kindLabel } from "./shared";

export interface DocumentPickerProps {
  documents: ManuscriptDocument[];
  selectedId: string | null;
  dirty: boolean;
  loading: boolean;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onSelect: (documentId: string) => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onNewDocument: () => void;
  onClose: () => void;
}

export default function DocumentPicker(props: DocumentPickerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const selectedDoc = props.documents.find((doc) => doc.id === props.selectedId) ?? null;

  useEffect(() => {
    function handleDown(event: MouseEvent): void {
      const target = event.target as HTMLElement;
      // 点顶栏「选择文档」按钮时交给它的 onClick 处理，避免 mousedown 关闭后被立刻重新打开。
      if (target.closest("[data-picker-toggle='true']") !== null) return;
      if (rootRef.current !== null && !rootRef.current.contains(target)) props.onClose();
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return props.documents.filter((doc) => {
      if (kindFilter !== "all" && doc.kind !== kindFilter) return false;
      if (keyword === "") return true;
      return (doc.title + " " + kindLabel(doc.kind)).toLowerCase().includes(keyword);
    });
  }, [props.documents, query, kindFilter]);

  return (
    <div className="rs-picker" ref={rootRef} role="dialog" aria-label="选择文档">
      <div className="rs-picker__head">
        <input
          className="rs-picker__search"
          type="search"
          placeholder="搜索文档"
          aria-label="搜索文档"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </div>

      <div className="rs-picker__filters" role="group" aria-label="按类型筛选">
        <button
          type="button"
          className={kindFilter === "all" ? "rs-picker__chip is-active" : "rs-picker__chip"}
          onClick={() => setKindFilter("all")}
        >
          全部
        </button>
        {MANUSCRIPT_DOCUMENT_KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={kindFilter === item.value ? "rs-picker__chip is-active" : "rs-picker__chip"}
            onClick={() => setKindFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="rs-picker__list">
        {props.loading ? (
          <p className="hint-text">加载文档…</p>
        ) : props.documents.length === 0 ? (
          <p className="hint-text">还没有文档，点下方「新建文档」开始。</p>
        ) : filtered.length === 0 ? (
          <p className="hint-text">没有匹配的文档。</p>
        ) : (
          filtered.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className={doc.id === props.selectedId ? "rs-picker__item is-active" : "rs-picker__item"}
              onClick={() => { props.onSelect(doc.id); props.onClose(); }}
            >
              <span className="rs-picker__item-title">{doc.title}</span>
              <span className="rs-picker__item-meta">
                {kindLabel(doc.kind) + " · " + doc.sectionCount + " 章 · " + doc.words + " 字 · " + formatDate(doc.updatedAt)}
                {doc.id === props.selectedId && props.dirty ? " · 未保存" : ""}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="rs-picker__foot">
        {props.renaming ? (
          <div className="rs-picker__rename">
            <input
              className="rs-picker__rename-input"
              value={props.renameDraft}
              disabled={props.busy}
              placeholder="新的文档标题"
              aria-label="新的文档标题"
              onChange={(event) => props.onRenameDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") props.onSaveRename();
                if (event.key === "Escape") props.onCancelRename();
              }}
              autoFocus
            />
            <button type="button" className="rs-ga__btn" disabled={props.busy} onClick={props.onSaveRename}>
              {props.busy ? "保存中…" : "保存"}
            </button>
            <button type="button" className="rs-ga__btn" disabled={props.busy} onClick={props.onCancelRename}>
              取消
            </button>
          </div>
        ) : (
          <div className="rs-picker__foot-row">
            <button type="button" className="rs-picker__new" onClick={props.onNewDocument}>
              ＋ 新建文档
            </button>
            {selectedDoc !== null && (
              <div className="rs-picker__docactions">
                <button type="button" className="rs-picker__link" disabled={props.busy} onClick={props.onStartRename}>
                  重命名
                </button>
                <button type="button" className="rs-picker__link is-danger" disabled={props.busy} onClick={props.onDelete}>
                  删除
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
