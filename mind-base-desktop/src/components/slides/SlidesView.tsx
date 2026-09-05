/**
 * PPT 制作入口页（#/slides）。
 *
 * 生成集成在对话里：chat agent 的 generate_slides 工具按主题生成大纲并
 * 渲染成 .pptx（默认结合知识库素材），保存到数据目录的 exports/ 文件夹。
 * 本页：说明、一键带请求进对话、以及**生成记录**列表。
 */

import { useCallback, useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatBytes, listExports } from "../../lib/exports";
import type { ExportEntry } from "../../lib/exports";
import { navigate, HOME_HASH } from "../../lib/router";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

function SlidesView(): React.JSX.Element {
  const [topic, setTopic] = useState("");
  const [records, setRecords] = useState<ExportEntry[] | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => {
    void listExports().then(
      (rows) => setRecords(rows.filter((row) => row.kind === "pptx")),
      () => setRecords([]),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function open(entry: ExportEntry): Promise<void> {
    try {
      await openPath(entry.path);
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "打开失败" });
    }
  }

  async function reveal(entry: ExportEntry): Promise<void> {
    try {
      await revealItemInDir(entry.path);
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "定位失败" });
    }
  }

  /** 带上主题跳回对话（用户手动发送，或先补充受众/页数）。 */
  function goChat(): void {
    const trimmed = topic.trim();
    window.sessionStorage.setItem(
      "mb-draft-input",
      trimmed !== ""
        ? `请帮我制作一套关于「${trimmed}」的 PPT`
        : "请帮我制作一套 PPT",
    );
    navigate(HOME_HASH);
  }

  return (
    <>
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">PT</span>PPT 制作
        </h2>
        <p className="hint-text">
          PPT 生成现在<b>集成在对话中</b>：告诉助手主题、受众和期望页数，它会先
          检索你的知识库取材、生成大纲，再渲染成 .pptx 文件（含每页要点与讲者
          备注），保存到数据目录的 exports 文件夹。主题范围或受众不明确时，
          助手会先向你提问再动手。
        </p>
        <div className="cfg-row">
          <span className="cfg-label">主题</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：如「RAG 系统架构与实践」"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={goChat}>
            去对话中生成
          </button>
        </div>
        <p className="hint-text">
          小技巧：说清受众（面试官/客户/新人）和页数偏好效果最好；入库资料
          越丰富，PPT 的内容越有据可依。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">⏱</span>生成记录
          <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
            {records !== null ? `${records.length} 份` : ""}
          </span>
        </h2>
        {records !== null && records.length === 0 && (
          <p className="hint-text">还没有生成过 PPT。在对话中生成后会自动出现在这里。</p>
        )}
        {records !== null && records.length > 0 && (
          <ul className="ws-docs">
            {records.map((entry) => (
              <li key={entry.path} className="ws-doc">
                <div className="ws-doc__head">
                  <span className="ws-doc__title" title={entry.path}>
                    {entry.name}
                  </span>
                  <span className="ws-doc__page-meta">
                    {new Date(entry.modifiedAt * 1000).toLocaleString()} ·{" "}
                    {formatBytes(entry.sizeBytes)}
                  </span>
                </div>
                <div className="ws-doc__page">
                  <span className="ws-doc__page-meta">PowerPoint 演示文稿</span>
                  <span className="ws-doc__page-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => void reveal(entry)}
                    >
                      所在文件夹
                    </button>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => void open(entry)}
                    >
                      打开
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default SlidesView;
