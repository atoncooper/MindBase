"use client";

import { useMemo, useState, type ReactNode, type ReactElement } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { escapeCodeText, highlightCode } from "@/lib/prism";

// Code blocks above this many lines render collapsed by default; the full
// body is one click away via the header toggle.
const COLLAPSE_THRESHOLD = 200;

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
// so every code block across the app gets the same treatment. Long blocks
// (> COLLAPSE_THRESHOLD lines) start collapsed with an expand toggle.
export function CodeBlock({ children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { text, language } = useMemo(() => extractCode(children), [children]);
  const html = useMemo(() => highlightCode(text, language), [text, language]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const collapsible = lineCount > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;

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
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] uppercase tracking-wide text-tertiary">
          {language || "code"}
          {collapsible && <span className="ml-2 normal-case">{lineCount} 行</span>}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-expanded={expanded}
              aria-label={expanded ? "折叠代码" : "展开代码"}
            >
              {expanded ? "折叠" : "展开"}
              <ChevronDown
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
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
        </span>
      </div>
      <div className="relative">
        <pre
          className={`m-0 overflow-x-auto px-3 py-2.5 text-[13px] leading-relaxed [tab-size:2] ${
            // ~24 lines preview at 13px/1.625 line height
            collapsed ? "max-h-[24rem] overflow-hidden" : ""
          }`}
        >
          {html != null ? (
            <code
              className={`font-mono text-foreground language-${language}`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <code className="font-mono text-foreground">{escapeCodeText(text)}</code>
          )}
        </pre>
        {/* Fade-out hint that there is more code below */}
        {collapsed && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[#f5f5f7]"
          />
        )}
      </div>
    </div>
  );
}
