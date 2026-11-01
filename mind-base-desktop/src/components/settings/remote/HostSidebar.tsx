//! 远程页左侧：顶部工具条（搜索/新建/复制/删除 + 连接状态）与会话列表。

import type { SshHostConfig, SshSessionInfo } from "../../../lib/ssh";
import type { ConnState } from "./shared";
import { pinnedFingerprint, projectLabel } from "./shared";
import type { HostsController } from "./useHosts";

export interface HostToolbarProps {
  hosts: HostsController;
  session: SshSessionInfo | null;
  connState: ConnState;
  statusLabel: string;
  statusClass: string;
  canConnect: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  /** 新建会话（打开弹窗）。 */
  onCreate: () => void;
  /** 编辑当前选中会话（打开弹窗）。 */
  onEdit: () => void;
}

/** 顶部工具条：搜索会话、新建/复制/删除，右侧连接/断开状态按钮。 */
export function HostToolbar(props: HostToolbarProps) {
  const {
    hosts,
    session,
    connState,
    statusLabel,
    statusClass,
    canConnect,
    onConnect,
    onDisconnect,
    onCreate,
    onEdit,
  } = props;
  return (
    <div className="remote-topbar">
      <div className="remote-topbar__left">
        <input
          className="cfg-input remote-search"
          type="search"
          placeholder="搜索会话（名称 / 主机 / 用户）"
          value={hosts.search}
          onChange={(event) => hosts.setSearch(event.target.value)}
        />
        <button type="button" className="button" onClick={onCreate}>
          新建会话
        </button>
        <button
          type="button"
          className="button"
          disabled={hosts.selectedHost === null || hosts.isNew || hosts.busy}
          onClick={onEdit}
        >
          编辑
        </button>
        <button
          type="button"
          className="button"
          disabled={hosts.selectedHost === null || hosts.busy}
          onClick={() => void hosts.handleDuplicate()}
        >
          复制
        </button>
        <button
          type="button"
          className="button"
          disabled={hosts.selectedHost === null || hosts.busy}
          onClick={() => void hosts.handleDelete()}
        >
          删除
        </button>
      </div>
      <div className="remote-topbar__right">
        <span className={statusClass}>{statusLabel}</span>
        {session !== null ? (
          <button type="button" className="button button--primary" onClick={onDisconnect}>
            断开
          </button>
        ) : (
          <button
            type="button"
            className="button button--primary"
            disabled={!canConnect}
            onClick={onConnect}
          >
            {connState === "connecting" ? "连接中…" : "连接"}
          </button>
        )}
      </div>
    </div>
  );
}

export interface HostSidebarProps {
  hosts: HostsController;
  session: SshSessionInfo | null;
  onSelect: (host: SshHostConfig) => void;
  /** 双击会话打开编辑弹窗。 */
  onEdit: (host: SshHostConfig) => void;
}

/** 左侧会话列表：名称 + user@host:port + 认证方式徽标 + 连接状态点 + 绑定/Agent/指纹徽标。 */
export default function HostSidebar({ hosts, session, onSelect, onEdit }: HostSidebarProps) {
  const { hosts: hostsState, hostList, selectedName, isNew, projects } = hosts;
  const query = hosts.search.trim().toLowerCase();
  const filteredHosts =
    query === ""
      ? hostList
      : hostList.filter((host) =>
          (host.name + " " + host.username + "@" + host.host + ":" + host.port)
            .toLowerCase()
            .includes(query),
        );

  return (
    <aside className="card remote-sidebar">
      <div className="remote-sidebar__head">
        <span className="remote-sidebar__title">会话</span>
        <span className="remote-sidebar__count">{hostList.length}</span>
      </div>
      <div className="remote-list" role="listbox" aria-label="SSH 会话列表">
        {hostsState.status !== "ok" ? (
          <p className="placeholder">
            {hostsState.status === "loading" ? "加载中…" : "会话列表读取失败"}
          </p>
        ) : filteredHosts.length === 0 ? (
          <p className="placeholder">
            {hostList.length === 0 ? "还没有会话，点击「新建会话」添加。" : "没有匹配的会话。"}
          </p>
        ) : (
          filteredHosts.map((host) => {
            const active = !isNew && selectedName === host.name;
            const live = session !== null && session.hostName === host.name;
            const boundProject = projectLabel(projects, host.projectId ?? "");
            const pinned = pinnedFingerprint(host);
            return (
              <button
                key={host.name}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? "remote-item remote-item--active" : "remote-item"}
                onClick={() => onSelect(host)}
                onDoubleClick={() => onEdit(host)}
                title="单击选中，双击编辑"
              >
                <span
                  className={live ? "remote-item__dot remote-item__dot--on" : "remote-item__dot"}
                  title={live ? "已连接" : "未连接"}
                />
                <span className="remote-item__main">
                  <span className="remote-item__name">{host.name}</span>
                  <span className="remote-item__target">
                    {host.username}@{host.host}:{host.port}
                  </span>
                  <span className="remote-item__badges">
                    {boundProject !== "" && (
                      <span
                        className="remote-item__badge remote-item__badge--project"
                        title={"绑定项目：" + boundProject}
                      >
                        {boundProject}
                      </span>
                    )}
                    {host.allowAgent && (
                      <span
                        className="remote-item__badge remote-item__badge--agent"
                        title={
                          (host.projectId ?? "") === ""
                            ? "允许 Agent 使用（未绑定项目时 Agent 仍无法使用）"
                            : "允许 Agent 使用"
                        }
                      >
                        Agent
                      </span>
                    )}
                    <span
                      className={
                        pinned !== ""
                          ? "remote-item__badge remote-item__badge--ok"
                          : "remote-item__badge"
                      }
                      title={pinned !== "" ? pinned : "尚未固定服务器指纹"}
                    >
                      {pinned !== "" ? "指纹已固定" : "指纹未信任"}
                    </span>
                  </span>
                </span>
                <span className="remote-item__auth">
                  {host.auth === "key" ? "密钥" : "密码"}
                </span>
              </button>
            );
          })
        )}
      </div>
      <p className="hint-text remote-sidebar__hint">
        凭据保存在系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service），
        不会上传；若系统凭据库不可用会退化为本机明文存储并给出提示。交互终端里的命令由你手动输入，
        只有 Agent 的 remote_exec 才会走危险命令黑名单；切换设置 tab 时终端保持挂载，离开设置页会断开当前会话。
      </p>
    </aside>
  );
}
