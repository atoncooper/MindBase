/**
 * PPT 制作页（#/slides）—— Google Slides 风格的历史展示页。
 *
 * 生成在主聊天完成：本页模板卡 / 自定义主题会**跳到对话并切换到 PPT 制作
 * 模式**（右上分段选择器），预填请求后发送即可；chat agent 的
 * generate_slides 工具按主题检索知识库、出大纲并渲染 .pptx 存到 exports/。
 * 右侧 = 生成记录（一轮结束后自动刷新）。
 */

import { useCallback, useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatBytes, listExports } from "../../lib/exports";
import type { ExportEntry } from "../../lib/exports";
import { navigate, HOME_HASH } from "../../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../../lib/chat";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

/** Google Slides 产品图标：黄色页面 + 折角 + 白色幻灯片。 */
function GoogleSlidesIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#fbbc04" d="M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5L14.5 2z" />
      <path fill="#fde293" d="M14.5 2 19 6.5h-3.5a1 1 0 0 1-1-1V2z" />
      <rect x="8.2" y="11.6" width="7.6" height="5.8" rx="0.8" fill="#fff" />
    </svg>
  );
}

/** 模板卡：一键切到 PPT 模式的对话（topic 为空 = 不限定主题）。 */
interface SlidesTemplate {
  id: string;
  name: string;
  hint: string;
  topic: string;
}

const SLIDES_TEMPLATES: ReadonlyArray<SlidesTemplate> = [
  { id: "blank", name: "空白演示", hint: "从零开始", topic: "" },
  { id: "report", name: "工作汇报", hint: "季度 / 周度总结", topic: "季度工作总结" },
  { id: "product", name: "产品介绍", hint: "卖点 + 场景", topic: "产品介绍" },
  { id: "training", name: "培训课件", hint: "面向新人 / 客户", topic: "培训课件" },
];

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

  /** 带上主题跳到对话：一次性切到 PPT 制作模式并预填请求。 */
  function goChat(topic: string): void {
    const trimmed = topic.trim();
    window.sessionStorage.setItem(CHAT_MODE_JUMP_KEY, "slides");
    window.sessionStorage.setItem(
      "mb-draft-input",
      trimmed !== ""
        ? `请帮我制作一套关于「${trimmed}」的 PPT`
        : "请帮我制作一套 PPT",
    );
    navigate(HOME_HASH);
  }

  return (
    <div className="gen-layout">
      <section className="card gen-panel">
        <div className="gen-hero">
          <span className="gen-hero__icon" aria-hidden="true">
            <GoogleSlidesIcon />
          </span>
          <div className="gen-hero__text">
            <h2 className="gen-hero__title">PPT 制作</h2>
            <p className="gen-hero__sub">
              在对话里给出主题，助手先检索知识库取材、生成大纲，再渲染成 .pptx
              （含每页要点与讲者备注）。
            </p>
          </div>
        </div>

        <p className="gen-section-label">选择模板，进入 PPT 制作模式</p>
        <div className="tpl-grid">
          {SLIDES_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="tpl-card"
              title={`以「${tpl.name}」为主题进入对话`}
              onClick={() => goChat(tpl.topic)}
            >
              <span className="tpl-card__icon" aria-hidden="true">
                <GoogleSlidesIcon />
              </span>
              <span className="tpl-card__name">{tpl.name}</span>
              <span className="tpl-card__hint">{tpl.hint}</span>
            </button>
          ))}
        </div>

        <div className="gen-box">
          <span className="gen-box__label">或自定义主题（可选）</span>
          <input
            type="text"
            className="gen-box__input"
            placeholder="如「RAG 系统架构与实践」，进入对话后可补充受众与页数"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") goChat(topic);
            }}
          />
          <div className="gen-box__actions">
            <button type="button" className="button button--primary" onClick={() => goChat(topic)}>
              进入 PPT 模式生成
            </button>
          </div>
        </div>

        <ol className="flow-steps">
          <li className="flow-step">
            <span className="flow-step__num">1</span>
            <span className="flow-step__text">
              <b>选模板进入对话</b>——自动切到 PPT 制作模式并预填主题，聊天历史随之只看 PPT 对话。
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-step__num">2</span>
            <span className="flow-step__text">
              <b>检索取材出大纲</b>——说清受众与页数，助手查知识库挑素材、给分页大纲，确认后动手。
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-step__num">3</span>
            <span className="flow-step__text">
              <b>查收 .pptx</b>——结果自动存到数据目录的 exports
              文件夹，右侧记录可直接打开；不满意可让它按反馈重做。
            </span>
          </li>
        </ol>
        <p className="hint-text gen-panel__hint">
          主题范围或受众不明确时，助手会先向你提问再动手；入库资料越丰富，内容越有据可依。
        </p>
      </section>

      <section className="card gen-side">
        <h2 className="card__title">
          生成记录
          <span className="card__count">{records !== null ? `${records.length} 份` : ""}</span>
        </h2>
        {records !== null && records.length === 0 && (
          <div className="gen-empty">
            <GoogleSlidesIcon />
            <p>还没有生成过 PPT。在对话里生成后会自动出现在这里。</p>
          </div>
        )}
        {records !== null && records.length > 0 && (
          <ul className="file-list">
            {records.map((entry) => (
              <li key={entry.path} className="file-row">
                <span className="file-row__icon" aria-hidden="true">
                  <GoogleSlidesIcon />
                </span>
                <span className="file-row__body">
                  <span className="file-row__name" title={entry.path}>
                    {entry.name}
                  </span>
                  <span className="file-row__meta">
                    {new Date(entry.modifiedAt * 1000).toLocaleString()} ·{" "}
                    {formatBytes(entry.sizeBytes)} · PowerPoint 演示文稿
                  </span>
                </span>
                <span className="file-row__actions">
                  <button type="button" className="button" onClick={() => void reveal(entry)}>
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default SlidesView;
