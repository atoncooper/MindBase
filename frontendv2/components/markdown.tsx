"use client";

/**
 * Shared Markdown renderer with GitHub-flavored markdown + LaTeX math support.
 *
 * - remark-math parses $...$ (inline) and $$...$$ (block) into math nodes.
 * - rehype-katex renders those nodes with KaTeX.
 * - KaTeX CSS is imported once globally in app/layout.tsx.
 * - Fenced code blocks are Prism-highlighted via <CodeBlock>.
 *
 * Use `inline` to render paragraphs as <span> (for buttons, list items, and
 * other inline contexts where a block <p> would break layout).
 */
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { CodeBlock } from "@/components/chat/code-block";

interface MarkdownProps {
    children: string;
    inline?: boolean;
}

const INLINE_COMPONENTS: Components = {
    p: ({ children }) => <span>{children as ReactNode}</span>,
};

// Block-level overrides: fenced code blocks render through <CodeBlock> so every
// code block gets Prism highlighting + a language label + copy button. Wide
// tables wrap in a horizontal scroll container instead of breaking the column.
const BLOCK_COMPONENTS: Components = {
    pre: ({ children }) => <CodeBlock>{children as ReactNode}</CodeBlock>,
    table: ({ children }) => (
        <div className="md-table-scroll">
            <table>{children as ReactNode}</table>
        </div>
    ),
};

const INLINE_BLOCK_COMPONENTS: Components = { ...INLINE_COMPONENTS, ...BLOCK_COMPONENTS };

export function Markdown({ children, inline }: MarkdownProps) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={inline ? INLINE_BLOCK_COMPONENTS : BLOCK_COMPONENTS}
        >
            {children}
        </ReactMarkdown>
    );
}
