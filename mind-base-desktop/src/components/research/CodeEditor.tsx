/**
 * VS Code 风格的轻量代码编辑器：Prism 高亮 + 行号 gutter + 透明 textarea 覆盖。
 *
 * textarea 始终是真实输入元素（IME 中文输入不受影响：composition 期间切回可见文字）；
 * 支持 Tab 插入 4 空格 / Shift+Tab 反缩进 / Enter 保持缩进（Python 冒号后 +4 空格）、
 * 高亮层与行号随 textarea 滚动同步；高度自适应到 maxHeight 后内部滚动。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Prism from "../mindmap/prismSetup";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-r";

/** language → Prism 语法名。 */
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
  python: "python",
  py: "python",
  sql: "sql",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  bash: "bash",
  sh: "bash",
  r: "r",
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineStartOf(value: string, position: number): number {
  return value.lastIndexOf("\n", position - 1) + 1;
}

export interface CodeEditorProps {
  /** 透传给 textarea（label htmlFor 用）。 */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** python（默认）/ sql / typescript / javascript / json / bash / r；未知按纯文本。 */
  language?: string;
  minHeight?: number;
  maxHeight?: number;
  ariaLabel?: string;
}

export default function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const minHeight = props.minHeight ?? 200;
  const maxHeight = props.maxHeight ?? 420;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [composing, setComposing] = useState(false);

  const grammar = GRAMMAR_BY_LANGUAGE[(props.language ?? "python").toLowerCase()] ?? null;
  const highlighted = useMemo(() => {
    if (props.value === "") return " ";
    if (grammar !== null && Prism.languages[grammar] !== undefined) {
      try {
        const html = Prism.highlight(props.value, Prism.languages[grammar], grammar);
        return html + (props.value.endsWith("\n") ? " " : "");
      } catch {
        // fall through
      }
    }
    return escapeHtml(props.value) + (props.value.endsWith("\n") ? " " : "");
  }, [props.value, grammar]);
  const lineNumbers = useMemo(
    () => Array.from({ length: props.value.split("\n").length }, (_, index) => index + 1),
    [props.value],
  );

  /** 高亮层 / 行号跟随 textarea 滚动。 */
  function syncScroll(): void {
    const textarea = taRef.current;
    if (textarea === null) return;
    if (preRef.current !== null) {
      preRef.current.scrollTop = textarea.scrollTop;
      preRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef.current !== null) gutterRef.current.scrollTop = textarea.scrollTop;
  }

  // 高度自适应到 maxHeight；超出后 textarea 内部滚动。
  useEffect(() => {
    const textarea = taRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    const next = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = next + "px";
    syncScroll();
  }, [props.value, minHeight, maxHeight]);

  function replaceValue(next: string, caret: number): void {
    props.onChange(next);
    requestAnimationFrame(() => {
      const textarea = taRef.current;
      if (textarea !== null) textarea.setSelectionRange(caret, caret);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        // 反缩进：删除当前行最多 4 个前导空格。
        const lineStart = lineStartOf(textarea.value, start);
        const leading = (textarea.value.slice(lineStart).match(/^[ \t]*/) ?? [""])[0];
        const remove = Math.min(4, leading.length);
        if (remove === 0) return;
        const next = textarea.value.slice(0, lineStart) + textarea.value.slice(lineStart + remove);
        replaceValue(next, Math.max(lineStart, start - remove));
        return;
      }
      const insert = "    ";
      const next = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
      replaceValue(next, start + insert.length);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const lineStart = lineStartOf(textarea.value, start);
      const line = textarea.value.slice(lineStart, start);
      const indent = (line.match(/^[ \t]*/) ?? [""])[0];
      const extra = (props.language ?? "python").toLowerCase() === "python" && line.trimEnd().endsWith(":") ? "    " : "";
      const insert = "\n" + indent + extra;
      const next = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
      replaceValue(next, start + insert.length);
    }
  }

  return (
    <div className="rs-codeeditor">
      <div className="rs-codeeditor__gutter" ref={gutterRef} aria-hidden="true">
        {lineNumbers.map((line) => (
          <span key={line} className="rs-codeeditor__ln">{line}</span>
        ))}
      </div>
      <pre className="rs-codeeditor__highlight" ref={preRef} aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
      <textarea
        id={props.id}
        ref={taRef}
        className={composing ? "rs-codeeditor__input is-composing" : "rs-codeeditor__input"}
        value={props.value}
        aria-label={props.ariaLabel ?? "代码编辑器"}
        spellCheck={false}
        wrap="off"
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
