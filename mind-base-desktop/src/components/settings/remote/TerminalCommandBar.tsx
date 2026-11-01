//! 终端命令输入行：Prism bash 高亮覆盖层 + 透明 textarea。
//!
//! Enter 发送（写入会话输入，追加 \r）、Shift+Enter 换行、↑/↓ 历史命令、
//! Esc 清空；命令仍经 TerminalPanel 的 onInput → ssh_write 转发，不改后端。

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SshSessionInfo } from "../../../lib/ssh";
import Prism from "../../mindmap/prismSetup";
import "prismjs/components/prism-bash";

export interface TerminalCommandBarProps {
  session: SshSessionInfo | null;
  /** 写入会话输入（父级转发 ssh_write；命令以 \r 结尾）。 */
  onInput: (data: string) => void;
}

/** 简单 HTML 转义（Prism 语法不可用时的兜底）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default function TerminalCommandBar({ session, onInput }: TerminalCommandBarProps) {
  const disabled = session === null;
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const highlighted = useMemo(() => {
    if (value === "") return "";
    const grammar = Prism.languages.bash;
    if (grammar === undefined) return escapeHtml(value);
    try {
      return Prism.highlight(value, grammar, "bash");
    } catch {
      return escapeHtml(value);
    }
  }, [value]);

  // 切换会话时清空输入与历史，避免把上一台主机的命令发到新主机。
  useEffect(() => {
    setValue("");
    setHistory([]);
    setHistoryIndex(-1);
  }, [session?.sessionId]);

  // 多行自适应（最多约 6 行），高亮层与 textarea 同高。
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
    if (preRef.current !== null) preRef.current.scrollTop = el.scrollTop;
  }, [value]);

  function send(): void {
    if (disabled) return;
    onInput(value + "\r");
    if (value.trim() !== "") {
      setHistory((prev) => [...prev, value].slice(-100));
    }
    setHistoryIndex(-1);
    setValue("");
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function recall(direction: -1 | 1): void {
    if (history.length === 0) return;
    if (direction === -1) {
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(history[next] ?? "");
      return;
    }
    if (historyIndex === -1) return;
    const next = historyIndex + 1;
    if (next >= history.length) {
      setHistoryIndex(-1);
      setValue("");
    } else {
      setHistoryIndex(next);
      setValue(history[next] ?? "");
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "ArrowUp") {
      // 没有历史时把方向键让给 textarea（多行命令内移动光标）。
      if (history.length === 0) return;
      event.preventDefault();
      recall(-1);
      return;
    }
    if (event.key === "ArrowDown") {
      if (historyIndex === -1) return;
      event.preventDefault();
      recall(1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setValue("");
      setHistoryIndex(-1);
    }
  }

  return (
    <div className="remote-cmd">
      <div className="remote-cmd__editor">
        <pre className="remote-cmd__pre" ref={preRef} aria-hidden="true">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
        <textarea
          ref={textareaRef}
          className="remote-cmd__input"
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          disabled={disabled}
          placeholder={disabled ? "连接服务器后可输入命令…" : "输入命令，Enter 发送…"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={(event) => {
            if (preRef.current !== null) preRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>
      <p className="remote-cmd__hint">
        Enter 发送 · Shift+Enter 换行 · ↑/↓ 历史 · Esc 清空 · 全屏程序（vim/top）请直接在终端操作
      </p>
    </div>
  );
}
