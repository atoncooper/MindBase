/**
 * 可交互 HTML 导出：把导图打包成一个自包含的 HTML 文件。
 *
 * 内联 simple-mind-map 的全量 UMD 包（含拖拽/富文本/公式等全部插件）+
 * 样式，浏览器双击即可打开，无需任何网络依赖。查看器为只读模式：双击
 * 不进编辑、节点不可选中/拖拽/增删；支持空白处拖拽平移、滚轮缩放、
 * 点击节点（或展开箭头）折叠/展开、工具栏展开全部/收起全部/适应画布，
 * 公式按 KaTeX 渲染。
 */

import type { MindMapDoc } from "../../lib/mindmap";

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : "&quot;",
  );
}

export function buildInteractiveHtml(
  title: string,
  doc: MindMapDoc,
  umdSource: string,
  cssSource: string,
): string {
  const safeTitle = escapeHtml(title);
  // 内联脚本防破栏：</script> 与 </style> 转义；JSON 数据把 < 转成 \u003c。
  const umd = umdSource.replace(/<\/script/gi, "<\\/script");
  const css = cssSource.replace(/<\/style/gi, "<\\/style");
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
</style>
<style>${css}</style>
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
  el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
})();
</script>
</body>
</html>
`;
}
