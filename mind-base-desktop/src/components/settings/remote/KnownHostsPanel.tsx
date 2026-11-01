//! 主机指纹管理面板：全部主机表格 + 逐行重置指纹（纯展示）。

import type { SshHostConfig } from "../../../lib/ssh";
import type { ResearchProject } from "../../../lib/research";
import type { Feedback } from "../../../lib/ui-state";
import { pinnedFingerprint, projectLabel } from "./shared";

export interface KnownHostsPanelProps {
  /** 当前是否停留在「主机指纹」tab（隐藏但保持挂载）。 */
  active: boolean;
  hostList: SshHostConfig[];
  projects: ResearchProject[];
  busyName: string | null;
  feedback: Feedback;
  onReset: (host: SshHostConfig) => void;
}

export default function KnownHostsPanel({
  active,
  hostList,
  projects,
  busyName,
  feedback,
  onReset,
}: KnownHostsPanelProps) {
  return (
    <div className="remote-tabpane remote-known" hidden={!active}>
      <p className="hint-text">
        TOFU：首次连接会自动固定服务器指纹；Agent 使用远程主机必须已固定指纹并开启 Agent
        授权。指纹变化（重装系统或中间人攻击）时应先核对再重置。
      </p>
      {hostList.length === 0 ? (
        <p className="remote-files__empty">还没有配置远程服务器。</p>
      ) : (
        <div className="remote-known__list">
          <div className="remote-known__row remote-known__row--head">
            <span>名称</span>
            <span>user@host:port</span>
            <span>绑定项目</span>
            <span>Agent</span>
            <span>指纹</span>
            <span>操作</span>
          </div>
          {hostList.map((host) => {
            const boundProject = projectLabel(projects, host.projectId ?? "");
            const pinned = pinnedFingerprint(host);
            return (
              <div className="remote-known__row" key={host.name}>
                <span className="remote-known__name">{host.name}</span>
                <span className="remote-known__target">
                  {host.username}@{host.host}:{host.port}
                </span>
                <span
                  className="remote-known__project"
                  title={boundProject === "" ? "未绑定项目" : boundProject}
                >
                  {boundProject === "" ? "未绑定" : boundProject}
                </span>
                <span
                  className={
                    host.allowAgent
                      ? "remote-known__agent remote-known__agent--on"
                      : "remote-known__agent"
                  }
                >
                  {host.allowAgent ? "允许" : "关闭"}
                </span>
                <span
                  className={
                    pinned !== ""
                      ? "remote-known__fp remote-known__fp--ok"
                      : "remote-known__fp"
                  }
                  title={pinned === "" ? "尚未固定指纹" : pinned}
                >
                  {pinned !== "" ? "已固定" : "未信任"}
                </span>
                <span className="remote-known__actions">
                  <button
                    type="button"
                    className="button"
                    disabled={pinned === "" || busyName !== null}
                    onClick={() => onReset(host)}
                  >
                    {busyName === host.name ? "处理中…" : "重置指纹"}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {feedback !== null && (
        <p className={feedback.kind === "error" ? "error-text" : "hint-text"}>
          {feedback.text}
        </p>
      )}
    </div>
  );
}
