/**
 * PPT 制作入口页（#/slides）。
 *
 * 生成集成在对话里：chat agent 的 generate_slides 工具按主题生成大纲并
 * 渲染成 .pptx（含每页要点与讲者备注），保存到「数据目录/exports/」。
 * 本页只做说明与一键带请求进对话。
 */

import { useState } from "react";
import { navigate, HOME_HASH } from "../../lib/router";

function SlidesView(): React.JSX.Element {
  const [topic, setTopic] = useState("");

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
    <section className="card quiz-pane">
      <h2 className="card__title">
        <span className="card__index">PT</span>PPT 制作
      </h2>
      <p className="hint-text">
        PPT 生成现在<b>集成在对话中</b>：告诉助手主题、受众和期望页数，它会先
        生成大纲、再渲染成 .pptx 文件（含每页要点与讲者备注），保存到数据目录的
        exports 文件夹。主题范围或受众不明确时，助手会先向你提问再动手。
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
        小技巧：说清受众（面试官/客户/新人）和页数偏好效果最好；还可以让它
        「用知识库里入库的资料做 PPT」，内容会取自你的收藏与文档。
      </p>
    </section>
  );
}

export default SlidesView;
