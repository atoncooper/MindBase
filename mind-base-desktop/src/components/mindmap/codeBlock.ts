/**
 * 代码块助手：语言表（分组）、Prism 高亮、节点 HTML 构建与提取。
 * 编辑器（插入/更新节点）与代码块对话框共用；高亮结果直接写进节点
 * 数据，画布渲染与导出（PNG/SVG/PDF/HTML）天然带色。
 */

import Prism from "./prismSetup";
import "prismjs/components/prism-latex";
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
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-lua";

export interface LangItem {
  value: string;
  label: string;
  /** Prism 语法名（html → markup）。 */
  prism: string;
}

export interface LangGroup {
  name: string;
  items: ReadonlyArray<LangItem>;
}

export const LANGUAGE_GROUPS: ReadonlyArray<LangGroup> = [
  {
    name: "前端与标记",
    items: [
      { value: "html", label: "html", prism: "markup" },
      { value: "css", label: "css", prism: "css" },
      { value: "javascript", label: "javascript", prism: "javascript" },
      { value: "typescript", label: "typescript", prism: "typescript" },
      { value: "jsx", label: "jsx", prism: "jsx" },
      { value: "tsx", label: "tsx", prism: "tsx" },
      { value: "json", label: "json", prism: "json" },
      { value: "markdown", label: "markdown", prism: "markdown" },
    ],
  },
  {
    name: "后端与系统",
    items: [
      { value: "python", label: "python", prism: "python" },
      { value: "java", label: "java", prism: "java" },
      { value: "go", label: "go", prism: "go" },
      { value: "rust", label: "rust", prism: "rust" },
      { value: "c", label: "c", prism: "c" },
      { value: "cpp", label: "cpp", prism: "cpp" },
      { value: "csharp", label: "csharp", prism: "csharp" },
      { value: "php", label: "php", prism: "php" },
      { value: "ruby", label: "ruby", prism: "ruby" },
      { value: "kotlin", label: "kotlin", prism: "kotlin" },
      { value: "swift", label: "swift", prism: "swift" },
      { value: "lua", label: "lua", prism: "lua" },
    ],
  },
  {
    name: "脚本与数据",
    items: [
      { value: "bash", label: "bash", prism: "bash" },
      { value: "sql", label: "sql", prism: "sql" },
      { value: "graphql", label: "graphql", prism: "graphql" },
      { value: "yaml", label: "yaml", prism: "yaml" },
      { value: "toml", label: "toml", prism: "toml" },
      { value: "docker", label: "docker", prism: "docker" },
    ],
  },
];

const LANG_PRISM: Record<string, string> = {
  ...Object.fromEntries(
    LANGUAGE_GROUPS.flatMap((group) => group.items.map((item) => [item.value, item.prism] as const)),
  ),
  latex: "latex",
};

export function escapeCodeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Prism 高亮；无语言标注或解析异常时退回纯文本转义。 */
export function highlightCode(code: string, language: string): string {
  const grammarName = LANG_PRISM[language];
  if (grammarName !== undefined && Prism.languages[grammarName] !== undefined) {
    try {
      return Prism.highlight(code, Prism.languages[grammarName], grammarName);
    } catch {
      // fall through
    }
  }
  return escapeCodeText(code);
}

/**
 * 构建写进节点数据的代码卡片 HTML。
 *
 * 刻意不用 `<pre>`：节点富文本走 `<p>`/`<span>` 渲染路径（与普通节点
 * 一致，foreignObject 下表现可控），代码按行拆分为 `p.smm-code-line`，
 * 逐行做 Prism 高亮（空行用零宽空格保持行高）。行外包一层限高滚动容器
 * `div.smm-code-scroll`：长代码卡片在画布上高度封顶、卡片内滚轮下翻
 * （MindMapCanvas 在捕获阶段拦截卡片内 wheel，避免触发画布缩放）。
 */
export function buildCodeBlockHtml(code: string, language: string): string {
  const langLabel =
    language === "" ? "" : `<p class="smm-code-lang">${escapeCodeText(language)}</p>`;
  const lines = code
    .split("\n")
    .map((line) =>
      line === ""
        ? `<p class="smm-code-line">\u200b</p>`
        : `<p class="smm-code-line">${highlightCode(line, language)}</p>`,
    );
  return `${langLabel}<div class="smm-code-scroll">${lines.join("")}</div>`;
}

export interface CodeBlockExtract {
  code: string;
  language: string;
}

/**
 * 按最长行估算代码节点的合适宽度（px）：半角字符 ≈ 7.6px（0.85em ×
 * 默认 14–16px 节点字号下的等宽字宽），全角/CJK 按 2 倍计，另加卡片
 * 内边距。夹在 [260, 560]——过窄难读、过宽撑爆画布；超出上限的行由
 * 画布端 pre-wrap 软换行承接。
 */
export function estimateCodeNodeWidth(code: string): number {
  let maxUnits = 0;
  for (const line of code.split("\n")) {
    let units = 0;
    for (const ch of line) {
      units += ch.charCodeAt(0) > 0xff ? 2 : 1;
    }
    maxUnits = Math.max(maxUnits, units);
  }
  return Math.min(560, Math.max(260, Math.round(maxUnits * 7.6) + 24));
}

/**
 * 判断节点文本是否为代码卡片（现行逐行 p.smm-code-line 或旧 pre.smm-code-block）。
 * 双击拦截守卫与内容提取共用同一判定，避免格式演进时守卫漏判。
 */
export function isCodeBlockText(text: string): boolean {
  return text.includes("smm-code-line") || text.includes("smm-code-block");
}

/** 从代码节点的富文本 HTML 里提取代码与语言；非代码节点返回 null。 */
export function extractCodeBlock(html: string): CodeBlockExtract | null {
  if (!isCodeBlockText(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 现行格式：逐行 p.smm-code-line；兼容旧格式：pre.smm-code-block。
  const lineEls = Array.from(doc.querySelectorAll("p.smm-code-line"));
  if (lineEls.length > 0) {
    return {
      language: (doc.querySelector("p.smm-code-lang")?.textContent ?? "").trim(),
      code: lineEls.map((line) => line.textContent ?? "").join("\n").replace(/\u200b/g, ""),
    };
  }
  const block = doc.querySelector("pre.smm-code-block");
  if (block === null) return null;
  return {
    language: (block.querySelector(".smm-code-lang")?.textContent ?? "").trim(),
    code: block.querySelector("code")?.textContent ?? "",
  };
}
