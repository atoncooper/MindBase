"use client";

import { useMemo, useState, type ReactNode, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import { escapeCodeText, highlightCode } from "@/lib/prism";

interface CodeBlockProps {
  children: ReactNode;
}

// Props shape we need from the react-markdown-rendered <code> element
// (ReactElement's default props type is `unknown` in @types/react 19).
interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

function isElement(node: ReactNode): node is ReactElement<CodeElementProps> {
  return !!node && typeof node === "object" && "props" in node;
}

// Flatten react-markdown's code children (string | string[] | nested) to text.
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isElement(node)) return nodeToText(node.props.children);
  return "";
}

// Extract the raw code text + language token from the <code class="language-xxx">
// child rendered by react-markdown for fenced code blocks.
function extractCode(children: ReactNode): { text: string; language: string } {
  const child = Array.isArray(children) ? children.find(isElement) : children;
  if (isElement(child)) {
    const m = /language-([\w+-]+)/.exec(child.props.className ?? "");
    return { text: nodeToText(child.props.children), language: m?.[1] ?? "" };
  }
  return { text: nodeToText(children), language: "" };
}

// Fenced code block: Prism syntax highlighting on the same light gray surface,
// with a language label + copy button. Used by the shared <Markdown> renderer
// so every code block across the app gets the same treatment.
export function CodeBlock({ children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { text, language } = useMemo(() => extractCode(children), [children]);
  const html = useMemo(() => highlightCode(text, language), [text, language]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  return (
    <div className="md-code my-3 overflow-hidden rounded-xl border border-border bg-[#f5f5f7]">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-tertiary">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
          aria-label={copied ? "已复制" : "复制代码"}
        >
          {copied ? (
            <Check className="h-3 w-3 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3" aria-hidden="true" />
          )}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 text-[13px] leading-relaxed [tab-size:2]">
        {html != null ? (
          <code
            className={`font-mono text-foreground language-${language}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code className="font-mono text-foreground">{escapeCodeText(text)}</code>
        )}
      </pre>
    </div>
  );
}
