//! 交互终端面板：xterm 实例、ssh-output / ssh-closed 监听、输出缓存与终端工具栏。
//!
//! 终端实例与事件监听只存在于此组件；会话状态、连接/断开与输入转发由
//! 父级 useSession 控制器持有（通过 props / 命令式句柄交互）。

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SshClosedEvent, SshOutputEvent, SshSessionInfo } from "../../../lib/ssh";
import { copyText } from "./shared";
import type { ConnState, TerminalPanelHandle } from "./shared";
import TerminalCommandBar from "./TerminalCommandBar";

/** 终端字号记忆（12–18，默认 14）。 */
const FONT_SIZE_KEY = "mb.ssh.terminal-font-size";
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 18;
const DEFAULT_FONT_SIZE = 14;

function loadTerminalFontSize(): number {
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isInteger(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_FONT_SIZE;
}

/** VS Code 深色终端配色。 */
const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
} as const;

export interface TerminalPanelProps {
  /** 当前是否停留在「终端」tab（隐藏但保持挂载）。 */
  active: boolean;
  /** 整个设置页是否隐藏（hidden 属性）。 */
  pageHidden: boolean;
  session: SshSessionInfo | null;
  connState: ConnState;
  statusLabel: string;
  statusClass: string;
  termNotice: string | null;
  onNotice: (text: string | null) => void;
  /** 用户按键输入（父级转发 ssh_write）。 */
  onInput: (data: string) => void;
  /** 终端尺寸变化（父级转发 ssh_resize）。 */
  onResize: (cols: number, rows: number) => void;
  /** 远端关闭事件（父级清理会话状态）。 */
  onClosed: (reason: string) => void;
  onDisconnect: () => void;
  /** 用系统应用打开日志文件（父级调用 opener）。 */
  onOpenLog: (path: string) => void;
}

const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
  function TerminalPanel(props, ref) {
    const {
      active,
      pageHidden,
      session,
      connState,
      statusLabel,
      statusClass,
      termNotice,
      onNotice,
      onInput,
      onResize,
      onClosed,
      onDisconnect,
      onOpenLog,
    } = props;
    const hostRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    // 连接期间到达的 ssh-output / ssh-closed 先缓存：sessionId 要等 ssh_connect
    // resolve 后才知道，直接按 sessionId 过滤会丢掉首批输出（含 shell prompt）。
    const connectingRef = useRef(false);
    const justConnectedRef = useRef(false);
    const pendingOutputRef = useRef<Array<{ sessionId: string; data: string }>>([]);
    const pendingClosedRef = useRef<SshClosedEvent | null>(null);
    // 首次可见时才创建 xterm：display:none 容器里 open 拿不到尺寸，容易渲染异常。
    const [everVisible, setEverVisible] = useState(!pageHidden);
    // 终端字号：默认 14，A−/A+ 调整并记忆到 localStorage。
    const [fontSize, setFontSize] = useState(loadTerminalFontSize);

    // 事件回调用 latest-ref，避免 xterm 生命周期 effect 捕获旧 props。
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const onClosedRef = useRef(onClosed);
    const onNoticeRef = useRef(onNotice);
    useEffect(() => {
      onInputRef.current = onInput;
      onResizeRef.current = onResize;
      onClosedRef.current = onClosed;
      onNoticeRef.current = onNotice;
    });

    useEffect(() => {
      sessionIdRef.current = session?.sessionId ?? null;
    }, [session?.sessionId]);
    useEffect(() => {
      connectingRef.current = connState === "connecting";
    }, [connState]);
    useEffect(() => {
      if (!pageHidden) setEverVisible(true);
    }, [pageHidden]);

    useImperativeHandle(
      ref,
      () => ({
        prepareConnect(): void {
          connectingRef.current = true;
          justConnectedRef.current = true;
          pendingOutputRef.current = [];
          pendingClosedRef.current = null;
          termRef.current?.reset();
          try {
            fitRef.current?.fit();
          } catch {
            // ignore
          }
        },
        finishConnect(): void {
          connectingRef.current = false;
        },
        setSessionId(sessionId: string | null): void {
          sessionIdRef.current = sessionId;
          if (sessionId === null) return;
          // 连接期间缓存的输出在拿到 sessionId 时立即回放（避免与后续实时输出乱序）。
          const pending = pendingOutputRef.current;
          pendingOutputRef.current = [];
          const term = termRef.current;
          if (term !== null) {
            for (const chunk of pending) {
              if (chunk.sessionId === sessionId) term.write(chunk.data);
            }
          }
        },
        consumePendingClosed(sessionId: string): { sessionId: string; reason: string } | null {
          const closed = pendingClosedRef.current;
          pendingClosedRef.current = null;
          if (closed === null || closed.sessionId !== sessionId) return null;
          return closed;
        },
        writeLine(text: string): void {
          termRef.current?.writeln(text);
        },
      }),
      [],
    );

    // xterm 只在首次可见时创建一次；事件监听先于任何 ssh_connect（否则可能丢 prompt）。
    useEffect(() => {
      if (!everVisible) return;
      const container = hostRef.current;
      if (container === null) return;
      container.replaceChildren();

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: TERMINAL_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      termRef.current = term;
      fitRef.current = fit;
      term.writeln("远程终端就绪。选择左侧会话并点击「连接」开始。");

      const dataSub = term.onData((data) => onInputRef.current(data));

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
        const key = event.key.toLowerCase();
        if (key === "c") {
          const selection = term.getSelection();
          if (selection !== "") {
            void copyText(selection).then((ok) => {
              onNoticeRef.current(ok ? "已复制选中内容" : "复制失败：剪贴板不可用");
            });
          }
          return false;
        }
        if (key === "v") {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text !== "") onInputRef.current(text);
            })
            .catch(() => onNoticeRef.current("读取剪贴板失败，请用「复制全部」并手动粘贴"));
          return false;
        }
        return true;
      });

      const fitAndResize = (): void => {
        try {
          fit.fit();
        } catch {
          // 容器隐藏（display:none）时 fit 会抛错，忽略即可，显示后会重新 fit。
        }
        const sessionId = sessionIdRef.current;
        if (sessionId !== null) onResizeRef.current(term.cols, term.rows);
      };
      const observer = new ResizeObserver(() => fitAndResize());
      observer.observe(container);
      const rafId = window.requestAnimationFrame(fitAndResize);

      return () => {
        window.cancelAnimationFrame(rafId);
        observer.disconnect();
        dataSub.dispose();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, [everVisible]);

    useEffect(() => {
      let disposed = false;
      const unlisteners: UnlistenFn[] = [];
      void listen<SshOutputEvent>("ssh-output", (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.sessionId === sessionIdRef.current) {
          termRef.current?.write(payload.data);
          return;
        }
        if (connectingRef.current) pendingOutputRef.current.push(payload);
      }).then((fn) => {
        if (disposed) fn();
        else unlisteners.push(fn);
      });
      void listen<SshClosedEvent>("ssh-closed", (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.sessionId !== sessionIdRef.current) {
          if (connectingRef.current) pendingClosedRef.current = payload;
          return;
        }
        const reason = payload.reason !== "" ? payload.reason : "远端已关闭连接";
        const term = termRef.current;
        if (term !== null) {
          term.writeln("");
          term.writeln("[" + reason + "]");
        }
        onClosedRef.current(reason);
      }).then((fn) => {
        if (disposed) fn();
        else unlisteners.push(fn);
      });
      return () => {
        disposed = true;
        for (const fn of unlisteners) fn();
      };
    }, []);

    // 连接成功：回放连接期间缓存的输出，fit + resize，并把焦点交给终端。
    useEffect(() => {
      const sessionId = session?.sessionId ?? null;
      if (sessionId === null) return;
      const pending = pendingOutputRef.current;
      pendingOutputRef.current = [];
      const term = termRef.current;
      if (term !== null) {
        for (const chunk of pending) {
          if (chunk.sessionId === sessionId) term.write(chunk.data);
        }
      }
      const closed = pendingClosedRef.current;
      pendingClosedRef.current = null;
      if (closed !== null && closed.sessionId === sessionId) {
        // 连接刚建立就被远端关闭：按已断开处理，避免留下假连接状态。
        const reason = closed.reason !== "" ? closed.reason : "远端已关闭连接";
        if (term !== null) {
          term.writeln("");
          term.writeln("[" + reason + "]");
        }
        onClosedRef.current(reason);
        return;
      }
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      if (term !== null) onResizeRef.current(term.cols, term.rows);
      if (justConnectedRef.current) {
        justConnectedRef.current = false;
        term?.focus();
      }
    }, [session?.sessionId]);

    // 字号变化：应用到 xterm 并重新 fit（同步新的 cols/rows 给远端 PTY）。
    useEffect(() => {
      const term = termRef.current;
      if (term === null) return;
      term.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      const sessionId = sessionIdRef.current;
      if (sessionId !== null) onResizeRef.current(term.cols, term.rows);
    }, [fontSize]);

    function changeFontSize(delta: number): void {
      setFontSize((prev) => {
        const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prev + delta));
        try {
          window.localStorage.setItem(FONT_SIZE_KEY, String(next));
        } catch {
          // ignore
        }
        return next;
      });
    }

    // 从隐藏 tab / 其它面板切回终端时重新 fit，并把实际尺寸同步给远端 PTY。
    useEffect(() => {
      if (pageHidden || !active) return;
      const timer = window.setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
        const sessionId = sessionIdRef.current;
        const term = termRef.current;
        if (sessionId !== null && term !== null) onResizeRef.current(term.cols, term.rows);
      }, 60);
      return () => window.clearTimeout(timer);
    }, [pageHidden, active, session?.sessionId]);

    function handleClear(): void {
      const term = termRef.current;
      if (term === null) return;
      term.clear();
      term.write("\u001b[H");
      term.focus();
    }

    async function handleCopyAll(): Promise<void> {
      const term = termRef.current;
      if (term === null) return;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        lines.push(line === undefined ? "" : line.translateToString(true));
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) {
        onNotice("终端还没有输出可复制");
        return;
      }
      const ok = await copyText(lines.join("\n"));
      onNotice(
        ok ? "已复制终端全部输出（" + lines.length + " 行）" : "复制失败：剪贴板不可用",
      );
    }

    const logPath = session?.logPath ?? "";

    return (
      <div className="remote-tabpane remote-terminal" hidden={!active}>
        <div className="remote-terminal__bar">
          <span className={statusClass}>{statusLabel}</span>
          <span className="remote-terminal__spacer" />
          <button
            type="button"
            className="button remote-terminal__font"
            disabled={fontSize <= MIN_FONT_SIZE}
            aria-label="缩小终端字号"
            title="缩小终端字号"
            onClick={() => changeFontSize(-1)}
          >
            A−
          </button>
          <button
            type="button"
            className="button remote-terminal__font"
            disabled={fontSize >= MAX_FONT_SIZE}
            aria-label="放大终端字号"
            title="放大终端字号"
            onClick={() => changeFontSize(1)}
          >
            A+
          </button>
          <button
            type="button"
            className="button"
            disabled={session === null}
            onClick={onDisconnect}
          >
            断开
          </button>
          <button type="button" className="button" onClick={handleClear}>
            清屏
          </button>
          <button type="button" className="button" onClick={() => void handleCopyAll()}>
            复制全部
          </button>
        </div>
        {logPath !== "" && (
          <div className="remote-terminal__logbar">
            <span className="remote-terminal__loglabel">会话日志</span>
            <code className="remote-terminal__logpath" title={logPath}>
              {logPath}
            </code>
            <button
              type="button"
              className="button"
              onClick={() => {
                void copyText(logPath).then((ok) => {
                  onNotice(ok ? "已复制日志路径" : "复制失败：剪贴板不可用");
                });
              }}
            >
              复制路径
            </button>
            <button type="button" className="button" onClick={() => onOpenLog(logPath)}>
              打开
            </button>
          </div>
        )}
        <div className="remote-terminal__body">
          <div className="remote-terminal__xterm" ref={hostRef} />
          {session === null && (
            <div className="remote-terminal__hint">
              <p className="remote-terminal__hint-title">
                {connState === "connecting" ? "正在连接…" : "未连接"}
              </p>
              <p className="remote-terminal__hint-text">
                {connState === "connecting"
                  ? "正在建立 SSH 会话，请稍候。"
                  : "选择左侧会话后点击右上角「连接」，即可在这里输入命令。"}
              </p>
            </div>
          )}
        </div>
        <TerminalCommandBar session={session} onInput={onInput} />
        {termNotice !== null && (
          <p className="hint-text remote-terminal__notice">{termNotice}</p>
        )}
      </div>
    );
  },
);

export default TerminalPanel;
