/**
 * PPT 制作页（#/slides）：主题 → LLM 结构化大纲 → 导出 .pptx。
 *
 * 两段式：先「生成大纲」得到可预览的标题/要点/讲者备注（不满意可重新
 * 生成），满意后「导出 .pptx」——首次导出会按需安装 python-pptx 依赖
 * （可能需要几分钟），之后秒级完成。
 */

import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { exportSlides, generateSlidesOutline } from "../../lib/slides";
import type { SlidesOutline, SlidesGenEvent } from "../../lib/slides";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

function SlidesView(): React.JSX.Element {
  const [topic, setTopic] = useState("");
  const [slideCount, setSlideCount] = useState(8);
  const [audience, setAudience] = useState("");
  const [style, setStyle] = useState("");
  const [outline, setOutline] = useState<SlidesOutline | null>(null);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function generate(): Promise<void> {
    setError("");
    setOutline(null);
    setGenerating(true);
    try {
      const result = await generateSlidesOutline(
        {
          topic,
          slideCount,
          audience: audience.trim() || undefined,
          style: style.trim() || undefined,
        },
        (_event: SlidesGenEvent) => {
          /* 单阶段任务，转圈即可 */
        },
      );
      setOutline(result);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  async function exportPptx(): Promise<void> {
    if (outline === null) return;
    try {
      const path = await save({
        title: "导出演示文稿",
        defaultPath: `${outline.title || "演示文稿"}.pptx`,
        filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
      });
      if (path === null) return;
      setExporting(true);
      await exportSlides(outline, path);
      toast.success(`已导出到 ${path}`, { title: "已导出" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">PT</span>PPT 制作
        </h2>
        <p className="hint-text">
          输入主题生成完整大纲（含每页要点与讲者备注），确认后导出为 .pptx
          文件。可结合知识库主题，让内容来自你入库的资料。
        </p>

        <div className="cfg-row">
          <span className="cfg-label">主题</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="如「RAG 系统架构与实践」"
            value={topic}
            disabled={generating || exporting}
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>

        <div className="cfg-row">
          <span className="cfg-label">页数</span>
          <select
            className="cfg-input quiz-select"
            value={slideCount}
            disabled={generating || exporting}
            onChange={(event) => setSlideCount(Number(event.target.value))}
          >
            {[4, 6, 8, 10, 12, 15].map((value) => (
              <option key={value} value={value}>
                {value} 页
              </option>
            ))}
          </select>
        </div>

        <div className="cfg-row">
          <span className="cfg-label">受众</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：如「技术面试官」「新人培训」"
            value={audience}
            disabled={generating || exporting}
            onChange={(event) => setAudience(event.target.value)}
          />
        </div>

        <div className="cfg-row">
          <span className="cfg-label">风格</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：如「深入浅出」「商务简洁」"
            value={style}
            disabled={generating || exporting}
            onChange={(event) => setStyle(event.target.value)}
          />
        </div>

        {error !== "" && <p className="error-text">{error}</p>}
        <div className="card__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={generating || exporting || topic.trim() === ""}
            onClick={() => void generate()}
          >
            {generating ? (
              <>
                <span className="ingest__spinner" />
                正在策划大纲…
              </>
            ) : outline !== null ? (
              "重新生成大纲"
            ) : (
              "生成大纲"
            )}
          </button>
          {outline !== null && (
            <button
              type="button"
              className="button"
              disabled={generating || exporting}
              onClick={() => void exportPptx()}
            >
              {exporting ? (
                <>
                  <span className="ingest__spinner" />
                  渲染 .pptx 中…
                </>
              ) : (
                `导出 .pptx（${outline.slides.length} 页）`
              )}
            </button>
          )}
        </div>
      </section>

      {outline !== null && (
        <section className="card">
          <h2 className="card__title">
            <span className="card__index">◇</span>
            {outline.title}
            {outline.subtitle !== "" && (
              <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
                {outline.subtitle}
              </span>
            )}
          </h2>
          <ol className="ws-docs">
            {outline.slides.map((slide, index) => (
              <li key={index} className="ws-doc">
                <div className="ws-doc__head">
                  <span className="ws-doc__title">
                    {index + 1}. {slide.title}
                  </span>
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {slide.bullets.map((bullet, bulletIndex) => (
                    <li key={bulletIndex} className="ws-doc__page-meta">
                      {bullet}
                    </li>
                  ))}
                </ul>
                {slide.note !== "" && (
                  <p className="hint-text" style={{ marginTop: 4 }}>
                    🎤 {slide.note}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

export default SlidesView;
