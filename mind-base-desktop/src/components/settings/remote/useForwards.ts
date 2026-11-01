//! 本地端口转发控制器：当前会话转发列表、新增与删除。

import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { addSshForward, listSshForwards, removeSshForward } from "../../../lib/ssh";
import type { SshForwardInfo, SshSessionInfo } from "../../../lib/ssh";
import { toErrorMessage } from "../../../lib/updater";
import type { RightTab } from "./shared";

export interface UseForwardsOptions {
  session: SshSessionInfo | null;
  rightTab: RightTab;
}

/** 端口转发控制器返回值。 */
export interface ForwardsController {
  forwards: SshForwardInfo[];
  forwardsLoading: boolean;
  forwardsBusy: boolean;
  forwardsError: string | null;
  forwardsNotice: string | null;
  forwardLocalPort: string;
  forwardRemoteHost: string;
  forwardRemotePort: string;
  setForwardLocalPort: (value: string) => void;
  setForwardRemoteHost: (value: string) => void;
  setForwardRemotePort: (value: string) => void;
  handleAddForward: () => Promise<void>;
  handleRemoveForward: (forward: SshForwardInfo) => Promise<void>;
}

export function useForwards(options: UseForwardsOptions): ForwardsController {
  const { session, rightTab } = options;
  const sessionRef = useRef<string | null>(null);
  const [forwards, setForwards] = useState<SshForwardInfo[]>([]);
  const [forwardsLoading, setForwardsLoading] = useState(false);
  const [forwardsBusy, setForwardsBusy] = useState(false);
  const [forwardsError, setForwardsError] = useState<string | null>(null);
  const [forwardsNotice, setForwardsNotice] = useState<string | null>(null);
  const [forwardLocalPort, setForwardLocalPort] = useState("");
  const [forwardRemoteHost, setForwardRemoteHost] = useState("127.0.0.1");
  const [forwardRemotePort, setForwardRemotePort] = useState("");

  useEffect(() => {
    sessionRef.current = session?.sessionId ?? null;
  }, [session?.sessionId]);

  // 会话切换：清空转发列表与提示。
  useEffect(() => {
    setForwards([]);
    setForwardsError(null);
    setForwardsNotice(null);
  }, [session?.sessionId]);

  // 切到「转发」tab 时拉取当前会话的本地端口转发。
  useEffect(() => {
    if (rightTab !== "forwards" || session === null) return;
    void loadForwards(session.sessionId);
  }, [rightTab, session?.sessionId]);

  async function loadForwards(sessionId: string): Promise<void> {
    setForwardsLoading(true);
    setForwardsError(null);
    try {
      setForwards(await listSshForwards(sessionId));
    } catch (err) {
      setForwardsError(toErrorMessage(err));
    } finally {
      setForwardsLoading(false);
    }
  }

  async function handleAddForward(): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null || forwardsBusy) return;
    const localPort = Number(forwardLocalPort.trim());
    const remotePort = Number(forwardRemotePort.trim());
    const remoteHost = forwardRemoteHost.trim();
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      setForwardsError("本地端口需为 1-65535 的整数");
      return;
    }
    if (remoteHost === "") {
      setForwardsError("请填写远端主机");
      return;
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      setForwardsError("远端端口需为 1-65535 的整数");
      return;
    }
    setForwardsBusy(true);
    setForwardsError(null);
    setForwardsNotice(null);
    try {
      const info = await addSshForward(sessionId, localPort, remoteHost, remotePort);
      setForwardsNotice(
        "✓ 已添加转发 127.0.0.1:" +
          info.localPort +
          " → " +
          info.remoteHost +
          ":" +
          info.remotePort,
      );
      setForwardLocalPort("");
      setForwardRemotePort("");
      await loadForwards(sessionId);
    } catch (err) {
      setForwardsError("添加转发失败：" + toErrorMessage(err));
    } finally {
      setForwardsBusy(false);
    }
  }

  async function handleRemoveForward(forward: SshForwardInfo): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null || forwardsBusy) return;
    const confirmed = await confirm(
      "删除本地端口转发 127.0.0.1:" +
        forward.localPort +
        " → " +
        forward.remoteHost +
        ":" +
        forward.remotePort +
        "？",
      { title: "删除端口转发", kind: "warning" },
    );
    if (!confirmed) return;
    setForwardsBusy(true);
    setForwardsError(null);
    setForwardsNotice(null);
    try {
      await removeSshForward(sessionId, forward.id);
      setForwardsNotice("✓ 已删除转发 127.0.0.1:" + forward.localPort);
      await loadForwards(sessionId);
    } catch (err) {
      setForwardsError("删除转发失败：" + toErrorMessage(err));
    } finally {
      setForwardsBusy(false);
    }
  }

  return {
    forwards,
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
  };
}
