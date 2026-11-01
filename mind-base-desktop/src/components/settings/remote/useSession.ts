//! 交互式 SSH 会话控制器：连接/断开、会话恢复、输入与 resize 转发、卸载清理。
//!
//! 终端实例与 ssh-output / ssh-closed 监听留在 TerminalPanel；这里只持有会话状态，
//! 并通过命令式句柄让面板在连接前 reset/fit、失败时追加提示行。

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { connectSshHost, disconnectSsh, resizeSsh, writeSsh } from "../../../lib/ssh";
import type { SshHostConfig, SshSessionInfo } from "../../../lib/ssh";
import { toErrorMessage } from "../../../lib/updater";
import type { ConnState, TerminalPanelHandle } from "./shared";

export interface UseSessionOptions {
  /** xterm 面板句柄（reset/fit、追加提示行、connecting 标记）。 */
  terminalRef: RefObject<TerminalPanelHandle | null>;
  /** 连接成功后的回调（刷新主机表，同步 TOFU 指纹）。 */
  onConnected: () => void;
  /** 连接失败回调（用于指纹不匹配提示）。 */
  onConnectError: (hostName: string, message: string) => void;
  /** 连接开始前清空上一次的指纹不匹配提示。 */
  clearConnectError: () => void;
  /** 连接开始前清空表单反馈。 */
  clearFeedback: () => void;
}

/** 会话控制器返回值。 */
export interface SessionController {
  session: SshSessionInfo | null;
  connState: ConnState;
  termNotice: string | null;
  setTermNotice: (text: string | null) => void;
  /** 启动时恢复已存在的后端会话（不自动重连）。 */
  adopt: (info: SshSessionInfo | null) => void;
  connect: (host: SshHostConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  /** TerminalPanel 收到 ssh-closed 时回调。 */
  handleRemoteClosed: (reason: string) => void;
  /** 用户按键输入。 */
  writeInput: (data: string) => void;
  /** 终端尺寸变化。 */
  resizeTerminal: (cols: number, rows: number) => void;
}

export function useSession(options: UseSessionOptions): SessionController {
  const { terminalRef, onConnected, onConnectError, clearConnectError, clearFeedback } = options;
  const sessionRef = useRef<string | null>(null);
  const unmountedRef = useRef(false);
  const [session, setSession] = useState<SshSessionInfo | null>(null);
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [termNotice, setTermNotice] = useState<string | null>(null);

  // 路由离开（组件卸载）时主动断开，避免后台残留会话。
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId !== null) void disconnectSsh(sessionId).catch(() => {});
    };
  }, []);

  function adopt(info: SshSessionInfo | null): void {
    if (info === null) return;
    sessionRef.current = info.sessionId;
    terminalRef.current?.setSessionId(info.sessionId);
    setSession(info);
    setConnState("connected");
    setTermNotice("已恢复活动会话：" + info.hostName + "（" + info.host + "）");
  }

  async function connect(host: SshHostConfig): Promise<void> {
    if (connState === "connecting" || session !== null) return;
    // 清屏必须在 connect 之前：shell prompt 会经 ssh-output 异步到达，
    // connect resolve 后再 reset 会吞掉首批输出。
    terminalRef.current?.prepareConnect();
    setConnState("connecting");
    setTermNotice("正在连接 " + host.username + "@" + host.host + ":" + host.port + "…");
    clearFeedback();
    clearConnectError();
    try {
      const info = await connectSshHost(host.name);
      if (unmountedRef.current) {
        // 连接建立时页面已离开：回收后端会话，避免后台残留。
        void disconnectSsh(info.sessionId).catch(() => {});
        return;
      }
      sessionRef.current = info.sessionId;
      terminalRef.current?.setSessionId(info.sessionId);
      setSession(info);
      setConnState("connected");
      // 首次连接 TOFU：后端已写回指纹，同步一次主机表让列表显示「已固定」。
      onConnected();
      setTermNotice(
        "已连接：" +
          info.hostName +
          "（" +
          info.username +
          "@" +
          info.host +
          ":" +
          info.port +
          "）",
      );
      // 连接刚建立就被远端关闭：按已断开处理，避免留下假连接状态。
      const closed = terminalRef.current?.consumePendingClosed(info.sessionId) ?? null;
      if (closed !== null) {
        sessionRef.current = null;
        terminalRef.current?.setSessionId(null);
        setSession(null);
        setConnState("disconnected");
        const reason = closed.reason !== "" ? closed.reason : "远端已关闭连接";
        setTermNotice(reason);
        terminalRef.current?.writeLine("[" + reason + "]");
      }
    } catch (err) {
      sessionRef.current = null;
      terminalRef.current?.setSessionId(null);
      setSession(null);
      setConnState("disconnected");
      const message = toErrorMessage(err);
      onConnectError(host.name, message);
      if (!unmountedRef.current) {
        setTermNotice("连接失败：" + message);
        terminalRef.current?.writeLine("连接失败：" + message);
      }
    } finally {
      terminalRef.current?.finishConnect();
    }
  }

  async function disconnect(): Promise<void> {
    const sessionId = sessionRef.current;
    if (sessionId === null) return;
    sessionRef.current = null;
    terminalRef.current?.setSessionId(null);
    setSession(null);
    setConnState("disconnected");
    try {
      await disconnectSsh(sessionId);
      setTermNotice("已断开连接");
    } catch (err) {
      setTermNotice("已断开连接（" + toErrorMessage(err) + "）");
    }
    terminalRef.current?.writeLine("");
    terminalRef.current?.writeLine("[已断开连接]");
  }

  function handleRemoteClosed(reason: string): void {
    sessionRef.current = null;
    terminalRef.current?.setSessionId(null);
    setSession(null);
    setConnState("disconnected");
    setTermNotice(reason !== "" ? reason : "远端已关闭连接");
  }

  function writeInput(data: string): void {
    const sessionId = sessionRef.current;
    if (sessionId === null) return;
    void writeSsh(sessionId, data).catch((err) => {
      terminalRef.current?.writeLine("");
      terminalRef.current?.writeLine("写入失败：" + toErrorMessage(err));
    });
  }

  function resizeTerminal(cols: number, rows: number): void {
    const sessionId = sessionRef.current;
    if (sessionId === null) return;
    void resizeSsh(sessionId, cols, rows).catch(() => {});
  }

  return {
    session,
    connState,
    termNotice,
    setTermNotice,
    adopt,
    connect,
    disconnect,
    handleRemoteClosed,
    writeInput,
    resizeTerminal,
  };
}
