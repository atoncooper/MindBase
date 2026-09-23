/**
 * Runs BEFORE prismjs core evaluates: pre-seed the global with `manual: true`
 * so core skips its DOMContentLoaded auto-highlightAll (which would rewrite
 * SSR'd <code class="language-…"> nodes behind React's back and fight
 * hydration). Highlighting is done explicitly per code block via
 * lib/prism.ts instead.
 */
(globalThis as { Prism?: unknown }).Prism = { manual: true };
