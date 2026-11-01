/**
 * 写作主区域（Google Docs 画布）：浅灰背景 + 居中白色纸张。
 *
 * 导入的 Word/PDF 文档默认用 SourceViewer 原样展示（可切「文本视图」看抽取的
 * Markdown）；普通文档与文本视图仍按章节渲染「标题 + MarkdownContent」。
 */

import { useEffect, useState } from "react";
import type { ManuscriptDocument, ManuscriptSection } from "../../../lib/research";
import { MarkdownContent } from "../../chat/MarkdownContent";
import { kindLabel, textLength } from "./shared";
import SourceViewer, { sourceKindOf } from "./SourceViewer";

export interface ReadPageProps {
  projectId: string;
  document: ManuscriptDocument | null;
  /** 已按 ord 排序的章节（含 content）。 */
  rows: ManuscriptSection[];
  selectedSection: string;
  draft: string;
  dirty: boolean;
  loading: boolean;
  onNewDocument: () => void;
}

export default function ReadPage(props: ReadPageProps): React.JSX.Element {
  const sourcePath = props.document?.sourcePath ?? "";
  const safeSourcePath = typeof sourcePath === "string" ? sourcePath : "";
  const [viewMode, setViewMode] = useState<"source" | "text">(() =>
    safeSourcePath !== "" && sourceKindOf(safeSourcePath) !== "other" ? "source" : "text",
  );
  // 原生渲染失败时记下原因：自动切文本视图 + 顶部提示，可重试原始文档。
  const [sourceError, setSourceError] = useState<string | null>(null);

  // 切换文档时重置视图：docx/pdf 默认原始文档，其它默认文本视图。
  useEffect(() => {
    setViewMode(sourcePath !== "" && sourceKindOf(sourcePath) !== "other" ? "source" : "text");
    setSourceError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.document?.id]);

  if (props.loading) {
    return (
      <div className="rs-gd__canvas">
        <div className="rs-gd__loading"><p className="hint-text">加载文档…</p></div>
      </div>
    );
  }

  if (props.document === null) {
    return (
      <div className="rs-gd__canvas">
        <div className="rs-gd__hero">
          <h2 className="rs-gd__hero-title">开始写作</h2>
          <p className="hint-text">
            新建开题报告 / 研究计划 / 初稿 / 修改稿 / 投稿信，每份文档有独立章节与 Word / LaTeX 导出；
            正文用 Markdown + LaTeX 公式（如 $E=mc^2$）编写，点右上角「阅读」进入沉浸阅读与编辑。
          </p>
          <button type="button" className="rs-gd__hero-btn" onClick={props.onNewDocument}>
            新建文档
          </button>
        </div>
      </div>
    );
  }

  const sections = props.rows.map((row) => {
    const content = row.section === props.selectedSection && props.dirty ? props.draft : row.content;
    return { row, content, words: textLength(content) };
  });
  const totalWords = sections.reduce((sum, item) => sum + item.words, 0);
  const hasSource = safeSourcePath !== "";
  const showSource = hasSource && viewMode === "source";

  return (
    <div className="rs-gd__canvas">
      {hasSource && (
        <div className="rs-gd__viewbar">
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
          <span className="hint-text rs-gd__sourcepath" title={safeSourcePath}>{safeSourcePath}</span>
        </div>
      )}

      {sourceError !== null && hasSource && (
        <div className="rs-gd__sourceerr">
          <span className="rs-gd__sourceerr-text">
            {"原始文档渲染失败，已切换文本视图：" + sourceError}
          </span>
          <button
            type="button"
            className="rs-ga__btn"
            onClick={() => { setSourceError(null); setViewMode("source"); }}
          >
            重试原始文档
          </button>
        </div>
      )}

      {showSource ? (
        <SourceViewer
          projectId={props.projectId}
          path={safeSourcePath}
          onError={(message) => { setSourceError(message); setViewMode("text"); }}
        />
      ) : (
        <article className="rs-gd__paper">
          <header className="rs-gd__dochead">
            <h1 className="rs-gd__doctitle">{props.document.title}</h1>
            <p className="rs-gd__docmeta">
              {kindLabel(props.document.kind) + " · " + sections.length + " 节 · " + totalWords + " 字"}
              {props.dirty ? " · 含未保存修改" : ""}
            </p>
          </header>

          {sections.length === 0 ? (
            <p className="hint-text">这篇文档还没有章节。点右上角「大纲」→「＋ 新增章节」创建第一节。</p>
          ) : (
            sections.map((item, index) => (
              <section key={item.row.id === "" ? item.row.section : item.row.id} id={"rs-gd-sec-" + index} className="rs-gd__section">
                <h2 className="rs-gd__sectiontitle">{item.row.section}</h2>
                {item.content.trim() === "" ? (
                  <p className="hint-text rs-gd__empty">（本节暂无正文）</p>
                ) : (
                  <MarkdownContent content={item.content} />
                )}
              </section>
            ))
          )}
        </article>
      )}
    </div>
  );
}
