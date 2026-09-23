/**
 * Markdown 渲染节点助手：与代码块节点平行的"MD 卡片"。
 *
 * 源码存节点数据 `mdSource` 字段；画布文本 = react-markdown 渲染出的
 * 静态 HTML（renderToStaticMarkup），根节点带 `smm-md-card` 标记类供
 * 双击守卫判定（与 codeBlock.isCodeBlockText 同模型）。
 *
 * 数学公式：remark-math 解析 $...$（行内）与 $$...$$（块级），rehype-katex
 * 渲染为 KaTeX HTML（纯 CSS 排版、无 JS 依赖，画布/导出静态可用；KaTeX
 * CSS 已在 app/layout.tsx 全局引入）。
 *
 * 安全模型：react-markdown 默认不解析内联 HTML（未接 rehype-raw），
 * 无脚本注入面；URL 经 allowCanvasUrl 白名单。画布内的链接渲染为带
 * title 的 span——静态字符串无法拦截点击，锚点默认跳转会带走整个
 * SPA 会话；URL 仍保留在 mdSource 里可编辑。`pre` 在 foreignObject
 * 下不可靠（codeBlock 的教训），渲染为 div.smm-md-pre。
 */

import Markdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { renderToStaticMarkup } from "react-dom/server";

const MD_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];
// throwOnError=false：公式语法错误时 KaTeX 渲染 .katex-error 红色回显
// （静态 HTML 里也能看出笔误），而不是让整张卡片渲染失败。
const MD_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { throwOnError: false }]];

/** 画布/预览共用的 URL 白名单（http(s)/data:image/盘符/相对路径）。 */
function allowCanvasUrl(url: string): string {
  if (/^data:image\//i.test(url)) return url;
  if (/^(https?):/i.test(url)) return url;
  if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("/")) return url;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return "";
}

const MD_COMPONENTS: Components = {
  a({ children, href }) {
    return (
      <span className="smm-md-link" title={href}>
        {children}
      </span>
    );
  },
  pre({ children }) {
    return <div className="smm-md-pre">{children}</div>;
  },
};

/** markdown 源码 → 画布节点文本（静态 HTML 字符串）。 */
export function renderMdCardHtml(source: string): string {
  const inner = renderToStaticMarkup(
    <Markdown
      remarkPlugins={MD_PLUGINS}
      rehypePlugins={MD_REHYPE_PLUGINS}
      urlTransform={allowCanvasUrl}
      components={MD_COMPONENTS}
    >
      {source}
    </Markdown>,
  );
  return `<div class="smm-md-card">${inner}</div>`;
}

/** 画布双击守卫：渲染卡片根节点带专属标记类（与代码块判定互斥不重叠）。 */
export function isMdCardText(text: string): boolean {
  return text.includes("smm-md-card");
}

/** 旧节点无 mdSource 字段时的兜底：从渲染 HTML 里抽纯文本。 */
export function mdSourceFallback(text: string): string {
  const doc = new DOMParser().parseFromString(text, "text/html");
  return (doc.querySelector(".smm-md-card")?.textContent ?? "").trim();
}

/** 供对话框实时预览复用（与画布渲染完全同源）。 */
export { MD_PLUGINS, MD_REHYPE_PLUGINS, MD_COMPONENTS, allowCanvasUrl as MD_URL_TRANSFORM };
