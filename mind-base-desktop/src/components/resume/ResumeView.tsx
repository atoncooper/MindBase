/**
 * 简历生成页（#/resume）—— Google Docs 风格的历史展示页。
 *
 * 生成在主聊天完成：本页模板卡 / 自定义方向会**跳到对话并切换到简历制作
 * 模式**（右上分段选择器），预填请求后发送即可；chat agent 的
 * generate_resume 工具把对话提炼成 Markdown 简历存到 exports/。右侧 =
 * 生成记录（一轮结束后自动刷新）。
 */

import { useCallback, useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatBytes, listExports } from "../../lib/exports";
import type { ExportEntry } from "../../lib/exports";
import { navigate, HOME_HASH } from "../../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../../lib/chat";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

/** Google Docs 产品图标：蓝色页面 + 折角 + 白色文本行。 */
function GoogleDocIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285f4" d="M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5L14.5 2z" />
      <path fill="#a6c8fa" d="M14.5 2 19 6.5h-3.5a1 1 0 0 1-1-1V2z" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M9 12h6M9 15h6M9 18h3.5"
      />
    </svg>
  );
}

/** 模板卡：一键切到简历模式的对话（role 为空 = 不限定方向）。 */
interface ResumeTemplate {
  id: string;
  name: string;
  hint: string;
  role: string;
}

const RESUME_TEMPLATES: ReadonlyArray<ResumeTemplate> = [
  { id: "general", name: "通用简历", hint: "标准一页式", role: "" },
  { id: "swe", name: "软件工程师", hint: "项目 + 技术栈", role: "软件工程师" },
  { id: "pm", name: "产品经理", hint: "经历 + 成果", role: "产品经理" },
  { id: "da", name: "数据分析师", hint: "量化 + 洞察", role: "数据分析师" },
];

function ResumeView(): React.JSX.Element {
  const [targetRole, setTargetRole] = useState("");
  const [records, setRecords] = useState<ExportEntry[] | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => {
    void listExports().then(
      (rows) => setRecords(rows.filter((row) => row.kind === "markdown")),
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

  /** 带上求职方向跳到对话：一次性切到简历制作模式并预填请求。 */
  function goChat(role: string): void {
    const trimmed = role.trim();
    window.sessionStorage.setItem(CHAT_MODE_JUMP_KEY, "resume");
    window.sessionStorage.setItem(
      "mb-draft-input",
      trimmed !== ""
        ? `请根据我们的历史对话生成一份简历，求职方向是「${trimmed}」`
        : "请根据我们的历史对话生成一份简历",
    );
    navigate(HOME_HASH);
  }

  return (
    <div className="gen-layout">
      <section className="card gen-panel">
        <div className="gen-hero">
          <span className="gen-hero__icon" aria-hidden="true">
            <GoogleDocIcon />
          </span>
          <div className="gen-hero__text">
            <h2 className="gen-hero__title">简历生成</h2>
            <p className="gen-hero__sub">
              在对话里把项目、技能、经历聊具体，助手提炼成一份 Markdown 简历——
              <b>聊得越多，简历越详细</b>。
            </p>
          </div>
        </div>

        <p className="gen-section-label">选择模板，进入简历制作模式</p>
        <div className="tpl-grid">
          {RESUME_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="tpl-card"
              title={`以「${tpl.name}」方向进入对话`}
              onClick={() => goChat(tpl.role)}
            >
              <span className="tpl-card__icon" aria-hidden="true">
                <GoogleDocIcon />
              </span>
              <span className="tpl-card__name">{tpl.name}</span>
              <span className="tpl-card__hint">{tpl.hint}</span>
            </button>
          ))}
        </div>

        <div className="gen-box">
          <span className="gen-box__label">或自定义求职方向（可选）</span>
          <input
            type="text"
            className="gen-box__input"
            placeholder="如「算法实习生」「增长运营」，留空则由助手概括"
            value={targetRole}
            onChange={(event) => setTargetRole(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") goChat(targetRole);
            }}
          />
          <div className="gen-box__actions">
            <button type="button" className="button button--primary" onClick={() => goChat(targetRole)}>
              进入简历模式生成
            </button>
          </div>
        </div>

        <ol className="flow-steps">
          <li className="flow-step">
            <span className="flow-step__num">1</span>
            <span className="flow-step__text">
              <b>选模板进入对话</b>——自动切到简历制作模式并预填请求，聊天历史随之只看简历对话。
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-step__num">2</span>
            <span className="flow-step__text">
              <b>聊具体再生成</b>——把项目细节、技术栈和量化成果聊透，随时让助手重新生成。
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-step__num">3</span>
            <span className="flow-step__text">
              <b>查收简历</b>——结果自动存到数据目录的 exports
              文件夹，右侧记录可直接打开。
            </span>
          </li>
        </ol>
        <p className="hint-text gen-panel__hint">
          信息不足或求职方向不明时，助手会先向你提问再动手。
        </p>
      </section>

      <section className="card gen-side">
        <h2 className="card__title">
          生成记录
          <span className="card__count">{records !== null ? `${records.length} 份` : ""}</span>
        </h2>
        {records !== null && records.length === 0 && (
          <div className="gen-empty">
            <GoogleDocIcon />
            <p>还没有生成过简历。在对话里生成后会自动出现在这里。</p>
          </div>
        )}
        {records !== null && records.length > 0 && (
          <ul className="file-list">
            {records.map((entry) => (
              <li key={entry.path} className="file-row">
                <span className="file-row__icon" aria-hidden="true">
                  <GoogleDocIcon />
                </span>
                <span className="file-row__body">
                  <span className="file-row__name" title={entry.path}>
                    {entry.name}
                  </span>
                  <span className="file-row__meta">
                    {new Date(entry.modifiedAt * 1000).toLocaleString()} ·{" "}
                    {formatBytes(entry.sizeBytes)} · Markdown 简历
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

export default ResumeView;
