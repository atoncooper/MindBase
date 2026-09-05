/**
 * 简历生成入口页（#/resume）。
 *
 * 生成本身集成在对话里：chat agent 的 generate_resume 工具把全部历史对话
 * 提炼成 Markdown 简历，保存到数据目录的 exports/ 文件夹。本页：说明玩法、
 * 一键把请求带进对话、以及**生成记录**列表（打开文件 / 定位所在文件夹）。
 */

import { useCallback, useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatBytes, listExports } from "../../lib/exports";
import type { ExportEntry } from "../../lib/exports";
import { navigate, HOME_HASH } from "../../lib/router";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

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

  /** 带上求职方向跳回对话（用户手动发送，或先补充信息）。 */
  function goChat(): void {
    const role = targetRole.trim();
    window.sessionStorage.setItem(
      "mb-draft-input",
      role !== ""
        ? `请根据我们的历史对话生成一份简历，求职方向是「${role}」`
        : "请根据我们的历史对话生成一份简历",
    );
    navigate(HOME_HASH);
  }

  return (
    <>
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">RM</span>简历生成
        </h2>
        <p className="hint-text">
          简历生成现在<b>集成在对话中</b>：助手会把你和它聊过的项目、技能、经历
          全部提炼成一份 Markdown 简历，保存到数据目录的 exports 文件夹——
          <b>聊得越多，简历越详细</b>。信息不足或求职方向不明时，助手会先向你提问。
        </p>
        <div className="cfg-row">
          <span className="cfg-label">求职方向</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：如「前端工程师」「算法实习生」"
            value={targetRole}
            onChange={(event) => setTargetRole(event.target.value)}
          />
        </div>
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={goChat}>
            去对话中生成
          </button>
        </div>
        <p className="hint-text">
          小技巧：生成前多聊聊你的项目细节、技术栈和量化成果，简历的「项目经验」
          会明显更充实；生成后继续补充信息再让它重新生成即可。
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
          <p className="hint-text">还没有生成过简历。在对话中生成后会自动出现在这里。</p>
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
                  <span className="ws-doc__page-meta">Markdown 简历</span>
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

export default ResumeView;
