"use client";

import katex from "katex";
import "katex/dist/katex.min.css";

function renderTex(tex: string, displayMode: boolean): string {
    try {
        return katex.renderToString(tex, {
            displayMode,
            throwOnError: false,
        });
    } catch {
        // malformed LaTeX: fall back to raw text so the page never crashes
        return tex;
    }
}

/**
 * Render text containing LaTeX math.
 *
 * Handles two forms produced by the quiz LLM:
 * 1. Delimited math: `$...$` segments inside question text
 *    (e.g. "设函数 $f(x)=...$, 则极限 $\lim_{x\to0} f(x)$...")
 * 2. Bare LaTeX with no delimiters (options/answers like "-\frac{1}{6}")
 *    -> detected by a backslash command and rendered wholesale.
 * Plain text without `$` or `\command` is rendered as-is.
 */
export function MathText({ text, block = false }: { text: string; block?: boolean }) {
    if (!text) return null;

    // No $ delimiters but contains a LaTeX command -> render whole string as math.
    if (!text.includes("$") && /\\[a-zA-Z]/.test(text)) {
        return <span dangerouslySetInnerHTML={{ __html: renderTex(text, block) }} />;
    }

    // Split by $...$ preserving math segments; render each piece.
    const parts = text.split(/(\$[^$]+\$)/g);
    return (
        <>
            {parts.map((part, i) => {
                if (part.startsWith("$") && part.endsWith("$")) {
                    return (
                        <span
                            key={i}
                            dangerouslySetInnerHTML={{ __html: renderTex(part.slice(1, -1), false) }}
                        />
                    );
                }
                return <span key={i}>{part}</span>;
            })}
        </>
    );
}
