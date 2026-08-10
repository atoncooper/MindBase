"use client";

import { useState, useRef, type ReactNode, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  children: ReactNode;
}

function isElement(node: ReactNode): node is ReactElement {
  return !!node && typeof node === "object" && "props" in node;
}

// Extract the language token (e.g. "python") from the <code class="language-xxx">
// child rendered by react-markdown for fenced code blocks.
function pickLanguage(children: ReactNode): string {
  const child = Array.isArray(children) ? children.find(isElement) : children;
  if (child && typeof child === "object" && "props" in child) {
    const cls = (child as ReactElement<{ className?: string }>).props.className ?? "";
    const m = /language-([\w-]+)/.exec(cls);
    if (m) return m[1];
  }
  return "";
}

// Fenced code block with a language label + copy button on a ChatGPT-style
// light gray surface. Used by the shared <Markdown> renderer so every code
// block across the app gets the same treatment.
export function CodeBlock({ children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const language = pickLanguage(children);

  const handleCopy = async () => {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-[#f5f5f7]">
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
      <pre
        ref={preRef}
        className="m-0 overflow-x-auto px-3 py-2.5 text-[13px] leading-relaxed [&_code]:font-mono [&_code]:text-foreground"
      >
        {children}
      </pre>
    </div>
  );
}
