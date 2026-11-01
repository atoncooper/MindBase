//! 本地端口转发面板：当前会话转发列表 + 新增/删除表单（纯展示）。

import type { SshSessionInfo } from "../../../lib/ssh";
import { formatRemoteTime } from "./shared";
import type { ForwardsController } from "./useForwards";

export interface ForwardPanelProps {
  /** 当前是否停留在「转发」tab（隐藏但保持挂载）。 */
  active: boolean;
  session: SshSessionInfo | null;
  forwards: ForwardsController;
}

export default function ForwardPanel({ active, session, forwards }: ForwardPanelProps) {
  const {
    forwards: forwardList,
    forwardsLoading,
    forwardsBusy,
    forwardsError,
    forwardsNotice,
    forwardLocalPort,
    forwardRemoteHost,
    forwardRemotePort,
    setForwardLocalPort,
    setForwardRemoteHost,
    setForwardRemotePort,
    handleAddForward,
    handleRemoveForward,
  } = forwards;

  return (
    <div className="remote-tabpane remote-forwards" hidden={!active}>
      {session === null ? (
        <div className="remote-tabpane__empty">
          <p className="remote-tabpane__empty-title">未连接</p>
          <p className="remote-tabpane__empty-text">
            连接服务器后可添加本地端口转发（127.0.0.1:本地端口 → 远端主机:远端端口）。
          </p>
        </div>
      ) : (
        <>
          <div className="remote-forward-form">
            <label className="remote-forward-form__field">
              <span>本地端口</span>
              <input
                className="cfg-input"
                type="number"
                min={1}
                max={65535}
                step={1}
                placeholder="如 8080"
                value={forwardLocalPort}
                onChange={(event) => setForwardLocalPort(event.target.value)}
              />
            </label>
            <label className="remote-forward-form__field">
              <span>远端主机</span>
              <input
                className="cfg-input"
                type="text"
                placeholder="如 127.0.0.1 / db.internal"
                autoComplete="off"
                spellCheck={false}
                value={forwardRemoteHost}
                onChange={(event) => setForwardRemoteHost(event.target.value)}
              />
            </label>
            <label className="remote-forward-form__field">
              <span>远端端口</span>
              <input
                className="cfg-input"
                type="number"
                min={1}
                max={65535}
                step={1}
                placeholder="如 5432"
                value={forwardRemotePort}
                onChange={(event) => setForwardRemotePort(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button button--primary"
              disabled={forwardsBusy}
              onClick={() => void handleAddForward()}
            >
              {forwardsBusy ? "处理中…" : "添加转发"}
            </button>
          </div>
          {forwardsError !== null && <p className="error-text">{forwardsError}</p>}
          {forwardsNotice !== null && <p className="hint-text">{forwardsNotice}</p>}
          <div className="remote-forwards__list">
            {forwardsLoading ? (
              <p className="remote-files__empty">加载中…</p>
            ) : forwardList.length === 0 ? (
              <p className="remote-files__empty">还没有端口转发</p>
            ) : (
              forwardList.map((forward) => (
                <div className="remote-forward" key={forward.id}>
                  <code className="remote-forward__route">
                    127.0.0.1:{forward.localPort} → {forward.remoteHost}:
                    {forward.remotePort}
                  </code>
                  <span className="remote-forward__time">
                    {formatRemoteTime(forward.createdAt)}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={forwardsBusy}
                    onClick={() => void handleRemoveForward(forward)}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
          <p className="hint-text">
            仅本地端口转发（127.0.0.1 → 远端）；断开连接或离开设置页会自动清理。
          </p>
        </>
      )}
    </div>
  );
}
