"use client";

/**
 * Shared Markdown renderer with GitHub-flavored markdown + LaTeX math support.
 *
 * - remark-math parses $...$ (inline) and $$...$$ (block) into math nodes.
 * - rehype-katex renders those nodes with KaTeX.
 * - KaTeX CSS is imported once globally in app/layout.tsx.
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
// code block gets a ChatGPT-style light gray surface + language label + copy
// button. Inline code keeps the default chip styling from .md-body.
const BLOCK_COMPONENTS: Components = {
    pre: ({ children }) => <CodeBlock>{children as ReactNode}</CodeBlock>,
};

export function Markdown({ children, inline }: MarkdownProps) {
    const components: Components | undefined = inline
        ? { ...INLINE_COMPONENTS, ...BLOCK_COMPONENTS }
        : BLOCK_COMPONENTS;
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={components}
        >
            {children}
        </ReactMarkdown>
    );
}
