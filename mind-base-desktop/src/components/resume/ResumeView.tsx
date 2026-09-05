/**
 * 简历生成入口页（#/resume）。
 *
 * 生成本身集成在对话里：chat agent 的 generate_resume 工具会把全部历史
 * 对话提炼成 Markdown 简历并保存到「数据目录/exports/」。本页只做两件事：
 * 说明玩法（聊得越多简历越详细），以及一键把请求带进对话输入框。
 */

import { useState } from "react";
import { navigate, HOME_HASH } from "../../lib/router";

function ResumeView(): React.JSX.Element {
  const [targetRole, setTargetRole] = useState("");

  /** 带上求职方向跳回对话（用户手动发送，或先补充信息）。 */
  function goChat(): void {
    const role = targetRole.trim();
    window.sessionStorage.setItem(
      "mb-draft-input",
      role !== ""
        ? `请根据我们的历史对话生成一份简历，求职方向是「${role}」`
        : "请根据我们的历史对话生成一份简历",
    );
    // hash 路由跳转后由 ChatView 读取 sessionStorage 草稿（见消费注释）。
    navigate(HOME_HASH);
  }

  return (
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
  );
}

export default ResumeView;
