/**
 * 可交互 HTML 导出：把导图打包成一个自包含的 HTML 文件。
 *
 * 内联 simple-mind-map 的全量 UMD 包（full 入口已自动注册拖拽/富文本/
 * 公式等全部插件；公式 KaTeX 样式由 Formula 插件在实例化时注入页面），
 * 浏览器双击即可打开，无需任何网络依赖。查看器为只读模式：双击不进编辑、
 * 节点不可选中/拖拽/增删；支持空白处拖拽平移、滚轮缩放、卡片内容滚动、
 * 点击节点（或展开箭头）折叠/展开、工具栏展开全部/收起全部/适应画布。
 *
 * 卡片样式：代码卡片与 Markdown 卡片的排版规则来自编辑器的 mindmap.css
 * （应用作用域，导出页没有），这里以字面量色值内嵌一份只读等价样式——
 * 不内嵌则卡片塌成浏览器默认字体/无结构排版（历史 bug：字体被覆盖、
 * 内容显示不全）。库自带的 esm.min.css 是 quill 编辑器样式，只读节点用
 * 不到且 UMD 已运行时注入，不再内嵌。
 *
 * EXPORT_CARD_CSS 同时被 MindMapCanvas 复用：PNG/PDF/SVG 导出时库把
 * resetCss 注入序列化 SVG，这里把它替换为「默认 reset + 卡片样式 +
 * KaTeX 基线」，否则导出图里代码卡丢配色、MD 卡丢排版、公式露出 MathML。
 */

import type { MindMapDoc } from "@/lib/board-store";

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : "&quot;",
  );
}

/**
 * 卡片/公式的只读等价样式。选择器不带 .mm-canvas/.mm-frame 前缀（导出页
 * 没有应用作用域），色值取自应用设计 token 的字面量（#1d1d1f=ink、
 * #86868b=ink-2、#f5f5f4=wash、#d2d2d7=line-strong、#0071e3=accent），
 * 与 mindmap.css 的画布规则保持同形；库的离屏测量元素内容根同样带
 * .smm-richtext-node-wrap 类，测量与展示自动同一套限高。
 */
export const EXPORT_CARD_CSS = `
/* ── foreignObject 行高/margin 重置（与 mindmap.css 653-667 对齐）──
   节点文字经 foreignObject 以 HTML 渲染，会继承 body 的默认行高（~1.55）；
   而库按 1.2 行高测量节点尺寸，两边不一致会导致文字撑出节点边界、相邻节点重叠。
   <p> 的浏览器默认外边距也会把文本顶下去。 */
foreignObject, foreignObject div, foreignObject p, foreignObject span {
  line-height: 1.2;
}
foreignObject p, foreignObject div {
  margin: 0;
}
.smm-richtext-node-wrap { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }
.smm-richtext-node-wrap .smm-code-scroll {
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: #f5f5f4;
}
.smm-richtext-node-wrap .smm-code-scroll::-webkit-scrollbar { width: 8px; }
.smm-richtext-node-wrap .smm-code-scroll::-webkit-scrollbar-thumb { background: #d2d2d7; border-radius: 4px; }
foreignObject p.smm-code-lang {
  margin: 4px 0 2px;
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 10px;
  line-height: 1.4;
  color: #86868b;
}
foreignObject p.smm-code-line {
  margin: 0;
  padding: 1px 8px;
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.85em;
  line-height: 1.5;
  color: #1d1d1f;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #f5f5f4;
}
foreignObject .token.comment, foreignObject .token.prolog,
foreignObject .token.doctype, foreignObject .token.cdata {
  color: #86868b;
  font-style: italic;
}
foreignObject .token.punctuation, foreignObject .token.operator { color: #86868b; }
foreignObject .token.keyword, foreignObject .token.boolean, foreignObject .token.builtin {
  color: #4a6fa5;
  font-weight: 600;
}
foreignObject .token.string, foreignObject .token.char, foreignObject .token.attr-value { color: #2e8b74; }
foreignObject .token.number, foreignObject .token.tag,
foreignObject .token.attr-name, foreignObject .token.constant { color: #b0673f; }
foreignObject .token.function, foreignObject .token.class-name { color: #4a6fa5; }
.smm-md-card {
  font-family: "LXGW WenKai Screen", "PingFang SC", "MiSans",
    "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
  font-size: 0.9em;
  line-height: 1.65;
  color: #1d1d1f;
}
.smm-richtext-node-wrap .smm-md-card {
  display: block;
  max-height: 420px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: #fbfbfd;
}
.smm-richtext-node-wrap .smm-md-card::-webkit-scrollbar { width: 8px; }
.smm-richtext-node-wrap .smm-md-card::-webkit-scrollbar-thumb { background: #d2d2d7; border-radius: 4px; }
.smm-md-card h1 { margin: 10px 0 4px; font-size: 1.35em; font-weight: 600; }
.smm-md-card h2 { margin: 8px 0 4px; font-size: 1.2em; font-weight: 600; }
.smm-md-card h3 { margin: 6px 0 3px; font-size: 1.08em; font-weight: 600; }
.smm-md-card h4, .smm-md-card h5, .smm-md-card h6 { margin: 6px 0 3px; font-size: 1em; font-weight: 600; }
.smm-md-card p { margin: 4px 0; }
.smm-md-card ul, .smm-md-card ol { margin: 4px 0; padding-left: 1.5em; }
.smm-md-card li { margin: 2px 0; }
.smm-md-card blockquote { margin: 6px 0; padding: 2px 10px; color: #86868b; border-left: 3px solid #d2d2d7; }
.smm-md-card code {
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.9em;
  padding: 0 4px;
  background: #f5f5f4;
  border-radius: 3px;
}
.smm-md-card .smm-md-pre {
  margin: 6px 0;
  padding: 6px 8px;
  background: #f5f5f4;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.smm-md-card .smm-md-pre code { padding: 0; background: transparent; white-space: pre-wrap; }
.smm-md-card table { margin: 6px 0; border-collapse: collapse; }
.smm-md-card th, .smm-md-card td { padding: 2px 8px; border: 1px solid #d2d2d7; }
.smm-md-card hr { margin: 8px 0; border: none; border-top: 1px solid #f0f0f2; }
.smm-md-card img { max-width: 100%; }
.smm-md-card .smm-md-link { color: #0071e3; text-decoration: underline; }
.smm-md-card input[type="checkbox"] { pointer-events: none; }
.smm-md-card > :first-child { margin-top: 0; }
/* KaTeX（MD 卡片公式；公式节点的 .katex 样式由 Formula 插件注入）：
   行内公式随正文字号，块级公式限宽横滚；渲染错误以红色源码回显。 */
.smm-md-card .katex { font-size: 1.05em; }
.smm-md-card .katex-display { margin: 6px 0; padding: 2px 0; overflow-x: auto; overflow-y: hidden; }
.smm-md-card .katex-display > .katex { font-size: 1.15em; }
.smm-md-card .katex-error { color: #ff3b30; font-family: SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
`;

export function buildInteractiveHtml(
  title: string,
  doc: MindMapDoc,
  umdSource: string,
): string {
  const safeTitle = escapeHtml(title);
  // 内联脚本防破栏：</script> 转义；JSON 数据把 < 转成 \u003c。
  const umd = umdSource.replace(/<\/script/gi, "<\\/script");
  const dataJson = JSON.stringify(doc).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
html, body { margin: 0; height: 100%; }
#map { width: 100vw; height: 100vh; overflow: hidden; }
.mm-toolbar { position: fixed; top: 12px; right: 12px; z-index: 10; display: flex; gap: 6px; }
.mm-toolbar button { padding: 5px 12px; font: 13px/1.4 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f1f1e; background: #fff; border: 1px solid #cbcbc7; border-radius: 6px; cursor: pointer; }
.mm-toolbar button:hover { background: #f5f5f4; }
.mm-hint { position: fixed; left: 12px; bottom: 10px; z-index: 10; font: 11px/1.6 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #8b8b86; }
${EXPORT_CARD_CSS}
</style>
</head>
<body>
<div id="map"></div>
<div class="mm-toolbar">
  <button id="btn-expand" type="button">展开全部</button>
  <button id="btn-collapse" type="button">收起全部</button>
  <button id="btn-fit" type="button">适应画布</button>
</div>
<div class="mm-hint">只读查看 · 点击节点或箭头展开/收起 · 空白处拖拽平移 · 滚轮缩放</div>
<script>${umd}</script>
<script>
(function () {
  "use strict";
  var DATA = ${dataJson};
  var Ctor = window.simpleMindMap && (window.simpleMindMap.default || window.simpleMindMap);
  if (!Ctor) {
    document.body.innerHTML = "<p style=\\"padding:24px;font-family:system-ui\\">思维导图组件加载失败。</p>";
    return;
  }
  var mm = new Ctor({
    el: document.getElementById("map"),
    data: DATA.root,
    layout: DATA.layout || "logicalStructure",
    theme: "default",
    fit: true,
    mousewheelAction: "zoom",
    // 只读查看器：双击不进编辑、节点不可选中/拖拽/增删（库的 readonly 模式）。
    // 富文本渲染按节点 data.richText 逐节点生效；代码/MD 卡片的 customTextWidth
    // 依赖 RichText 插件（full 包已自动注册）。
    readonly: true,
    iconList: window.simpleMindMap.iconList || []
  });
  if (DATA.theme && DATA.theme.config) {
    mm.setThemeConfig(DATA.theme.config);
  }
  document.getElementById("btn-expand").addEventListener("click", function () { mm.execCommand("EXPAND_ALL"); });
  document.getElementById("btn-collapse").addEventListener("click", function () { mm.execCommand("UNEXPAND_ALL"); });
  document.getElementById("btn-fit").addEventListener("click", function () { mm.view.fit(); });
  // 点击节点本体切换展开/收起（有子级时）；展开箭头本身也可点。
  mm.on("node_click", function (node) {
    var children = (node.nodeData && node.nodeData.children) || [];
    if (children.length > 0) {
      mm.execCommand("SET_NODE_EXPAND", node, node.getData("expand") === false);
    }
  });
  // 与画布一致的查看手势：空白左键拖拽平移（Ctrl/Meta 留给框选，只读下同样无效）。
  var nodeDown = false;
  mm.on("node_mousedown", function () { nodeDown = true; });
  var el = document.getElementById("map");
  el.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    if (nodeDown) { nodeDown = false; return; }
    var lastX = e.clientX;
    var lastY = e.clientY;
    function move(ev) {
      mm.view.translateXY(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  // 卡片内滚轮：限高卡片可滚时拦下滚轮（捕获阶段先于库的缩放监听），
  // 已滚到边界时放行给画布缩放（与编辑器 MindMapCanvas 的捕获监听同逻辑）。
  el.addEventListener("wheel", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var scrollEl = t.closest(".smm-code-scroll, .smm-md-card");
    if (scrollEl === null) return;
    var atTop = scrollEl.scrollTop <= 0;
    var atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1;
    if (e.deltaY > 0 ? atBottom : atTop) return;
    e.stopPropagation();
  }, true);
  el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  // 键盘方向键移动画布（每次40px）；Space 键切换展开/收起当前节点。
  window.addEventListener("keydown", function (e) {
    // 忽略输入框内的按键
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    var step = 40;
    var dx = 0;
    var dy = 0;
    switch (e.key) {
      case "ArrowLeft":  dx = step;  break;
      case "ArrowRight": dx = -step; break;
      case "ArrowUp":    dy = step;  break;
      case "ArrowDown":  dy = -step; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    mm.view.translateXY(dx, dy);
  }, true);
})();
</script>
</body>
</html>
`;
}