/**
 * 独立「远程服务器」设置页（Xshell 风格）——只做状态编排与布局。
 *
 * 主机配置/表单/指纹在 remote/useHosts，交互会话在 remote/useSession，
 * SFTP 与端口转发分别在 remote/useSftp / remote/useForwards；
 * 展示组件都在 remote/ 下，xterm 实例与 ssh-output/ssh-closed 监听只在
 * remote/TerminalPanel 内部。交互终端里用户手动输入的命令不经过 Agent 黑名单。
 */

import { useEffect, useRef, useState } from "react";
import { listSshHosts, listSshSessions } from "../../lib/ssh";
import type { SshHostConfig } from "../../lib/ssh";
import { openPath } from "@tauri-apps/plugin-opener";
import { toErrorMessage } from "../../lib/updater";
import ConnectionDialog from "./remote/ConnectionDialog";
import ForwardPanel from "./remote/ForwardPanel";
import HostSidebar, { HostToolbar } from "./remote/HostSidebar";
import KnownHostsPanel from "./remote/KnownHostsPanel";
import SftpPanel from "./remote/SftpPanel";
import TerminalPanel from "./remote/TerminalPanel";
import { RIGHT_TABS } from "./remote/shared";
import type { RightTab, TerminalPanelHandle } from "./remote/shared";
import { useForwards } from "./remote/useForwards";
import { useHosts } from "./remote/useHosts";
import { useSession } from "./remote/useSession";
import type { SessionController } from "./remote/useSession";
import { useSftp } from "./remote/useSftp";
import "./remote-settings.css";

function RemoteHostsSettings({ hidden }: { hidden: boolean }) {
  // 右侧面板 tab：终端 / 文件（SFTP）/ 端口转发 / 主机指纹。
  const [rightTab, setRightTab] = useState<RightTab>("terminal");
  // 连接配置改为弹窗：新建 / 编辑 / 双击会话时打开。
  const [dialogOpen, setDialogOpen] = useState(false);
  // xterm 命令式句柄（reset/fit、提示行、会话 id 同步）。
  const terminalRef = useRef<TerminalPanelHandle | null>(null);
  // 会话控制器需要被主机控制器回调（断开/重试连接）引用，先声明 ref 再注入。
  const sessionRef = useRef<SessionController | null>(null);

  const hosts = useHosts({
    getSession: () => sessionRef.current?.session ?? null,
    connect: (host) => sessionRef.current?.connect(host) ?? Promise.resolve(),
    disconnect: () => sessionRef.current?.disconnect() ?? Promise.resolve(),
  });
  const session = useSession({
    terminalRef,
    onConnected: () => {
      void hosts.refreshHosts();
    },
    onConnectError: hosts.reportConnectError,
    clearConnectError: hosts.clearConnectError,
    clearFeedback: hosts.clearFeedback,
  });
  useEffect(() => {
    sessionRef.current = session;
  });

  const sftp = useSftp({ session: session.session, rightTab, hostList: hosts.hostList });
  const forwards = useForwards({ session: session.session, rightTab });

  // 启动引导：主机表 + 活动会话一次性加载（等价于原组件的合并 effect）。
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listSshHosts(), listSshSessions()]).then(
      ([hostsResult, sessionsResult]) => {
        if (cancelled) return;
        const live =
          sessionsResult.status === "fulfilled" && sessionsResult.value.length > 0
            ? sessionsResult.value[0]
            : null;
        hosts.applyBootstrap(hostsResult, live?.hostName ?? null);
        // 与原合并 effect 一致：主机表读取失败时不恢复会话。
        if (hostsResult.status === "fulfilled") session.adopt(live);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const canConnect =
    !hosts.isNew &&
    hosts.selectedHost !== null &&
    session.session === null &&
    session.connState !== "connecting" &&
    !hosts.busy;
  const statusLabel =
    session.session !== null
      ? "已连接 " + session.session.hostName
      : session.connState === "connecting"
        ? "连接中…"
        : "未连接";
  const statusClass =
    session.session !== null
      ? "status status--ok"
      : session.connState === "connecting"
        ? "status status--live"
        : "status";

  function handleOpenLog(path: string): void {
    void openPath(path).catch((err) => {
      session.setTermNotice("打开日志失败：" + toErrorMessage(err));
    });
  }

  function openCreateDialog(): void {
    hosts.startNew();
    setDialogOpen(true);
  }

  function openEditDialog(target?: SshHostConfig): void {
    const host = target ?? hosts.selectedHost;
    if (host === null) return;
    if (target !== undefined) hosts.selectHost(target);
    setDialogOpen(true);
  }

  function closeDialog(): void {
    // 取消/关闭：丢弃未保存草稿。
    hosts.discardDraft();
    setDialogOpen(false);
  }

  return (
    <div className="settings-pane remote-page" hidden={hidden}>
      <HostToolbar
        hosts={hosts}
        session={session.session}
        connState={session.connState}
        statusLabel={statusLabel}
        statusClass={statusClass}
        canConnect={canConnect}
        onConnect={() => {
          const host = hosts.selectedHost;
          if (host !== null) void session.connect(host);
        }}
        onDisconnect={() => void session.disconnect()}
        onCreate={openCreateDialog}
        onEdit={() => openEditDialog()}
      />

      <div className="remote-workspace">
        <HostSidebar
          hosts={hosts}
          session={session.session}
          onSelect={hosts.selectHost}
          onEdit={(host) => openEditDialog(host)}
        />

        <section className="card remote-panel">
          <div className="remote-panel__tabs" role="tablist" aria-label="远程面板">
            {RIGHT_TABS.map((tab) => {
              const muted =
                session.session === null && (tab.id === "files" || tab.id === "forwards");
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={rightTab === tab.id}
                  className={
                    "remote-panel__tab" +
                    (rightTab === tab.id ? " remote-panel__tab--active" : "") +
                    (muted ? " remote-panel__tab--muted" : "")
                  }
                  title={muted ? "连接服务器后可用" : undefined}
                  onClick={() => setRightTab(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="remote-panel__body">
            <TerminalPanel
              ref={terminalRef}
              active={rightTab === "terminal"}
              pageHidden={hidden}
              session={session.session}
              connState={session.connState}
              statusLabel={statusLabel}
              statusClass={statusClass}
              termNotice={session.termNotice}
              onNotice={session.setTermNotice}
              onInput={session.writeInput}
              onResize={session.resizeTerminal}
              onClosed={session.handleRemoteClosed}
              onDisconnect={() => void session.disconnect()}
              onOpenLog={handleOpenLog}
            />
            <SftpPanel active={rightTab === "files"} session={session.session} sftp={sftp} />
            <ForwardPanel
              active={rightTab === "forwards"}
              session={session.session}
              forwards={forwards}
            />
            <KnownHostsPanel
              active={rightTab === "hosts"}
              hostList={hosts.hostList}
              projects={hosts.projects}
              busyName={hosts.hostFingerprintBusy}
              feedback={hosts.hostFingerprintFeedback}
              onReset={(host) => void hosts.handleResetHostFingerprint(host)}
            />
          </div>
        </section>
      </div>

      {dialogOpen && (
        <ConnectionDialog
          hosts={hosts}
          onClose={closeDialog}
          onSaved={() => setDialogOpen(false)}
          onDeleted={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

export default RemoteHostsSettings;
