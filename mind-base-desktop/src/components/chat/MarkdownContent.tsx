/**
 * 共享 Markdown 渲染器：聊天消息流 / 会话总结弹窗 / 笔记预览共用。
 *
 * - 插件与组件映射是模块级常量，避免每次渲染重建数组；
 * - 链接一律经 Tauri opener 打开——webview 里的默认 <a> 跳转会把
 *   整个应用窗口导航离开应用外壳；
 * - streaming 时光标由 CSS 画在最后一个块级元素上（见 .is-streaming），
 *   不往 markdown 源里注入字符。
 */

import { memo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

const MD_PLUGINS = [remarkGfm, remarkBreaks];

/** Flatten a React node tree into its plain text (for the copy button). */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** Write text to the clipboard with an execCommand fallback (webview安全剪贴板权限差异). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** `<pre>` 容器：右上角悬浮复制按钮（截获的 children 原样透传渲染）。 */
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        type="button"
        className="code-block__copy"
        onClick={() => {
          void copyToClipboard(extractText(children)).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

const MD_COMPONENTS: Components = {
  pre: CodeBlock,
  a({ children, href }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (href === undefined || href === "") return;
          event.preventDefault();
          void openUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
};

interface MarkdownContentProps {
  content: string;
  /** 流式生成中：末尾绘制闪烁光标。 */
  streaming?: boolean;
}

function MarkdownContentImpl({
  content,
  streaming = false,
}: MarkdownContentProps): React.JSX.Element {
  return (
    <div className={streaming ? "md-content markdown-body is-streaming" : "md-content markdown-body"}>
      <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** memo 化：流式时只有正在生成的那条在变，历史消息零开销。 */
export const MarkdownContent = memo(MarkdownContentImpl);
