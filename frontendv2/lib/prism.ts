/**
 * Prism registry + highlight helper for Markdown-rendered code blocks (chat
 * messages, notes preview, quiz, board panel - everything that goes through
 * the shared <Markdown>). Keep the language set to what LLM answers actually
 * emit; unknown languages fall back to escaped plain text.
 */
import Prism from "./prism-mount";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-json";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-latex";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-graphql";

// Fence tag -> Prism grammar name. Prism core ships markup/css/clike/
// javascript; everything else comes from the component imports above.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  cs: "csharp",
  "c++": "cpp",
  cxx: "cpp",
  dockerfile: "docker",
  golang: "go",
  rb: "ruby",
  kt: "kotlin",
  md: "markdown",
  text: "",
  txt: "",
  plaintext: "",
  plain: "",
};

export function escapeCodeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Prism-highlight `text` tagged as `language`. Returns null when the language
 * is unknown or highlighting fails - callers render escaped plain text then.
 */
export function highlightCode(text: string, language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  const name = LANG_ALIASES[normalized] ?? normalized;
  const grammar = name ? Prism.languages[name] : undefined;
  if (!grammar) return null;
  try {
    return Prism.highlight(text, grammar, name);
  } catch {
    return null;
  }
}

export default Prism;
