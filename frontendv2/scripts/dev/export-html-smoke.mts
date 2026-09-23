/* Export-HTML smoke test: builds the interactive HTML with the real UMD asset
 * from public/ and checks structural invariants. Run: npx tsx scripts/dev/export-html-smoke.mts */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInteractiveHtml } from "../../components/mindmap/editor/exportHtml";

const root = process.cwd();
const umd = readFileSync(join(root, "public/simple-mind-map/simpleMindMap.umd.min.js"), "utf8");

const doc = {
  root: {
    data: { text: "中心主题", uid: "u1", smmVersion: "0.14.0-fix.3" },
    children: [
      {
        data: {
          uid: "u2",
          richText: true,
          text: '<div class="smm-md-card"><h2>标题</h2><p>公式 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi></mrow></semantics></math></span></span></p><div class="smm-md-pre"><code>code</code></div></div>',
        },
        children: [],
      },
      {
        data: {
          uid: "u3",
          richText: true,
          text: '<div><p class="smm-code-lang">python</p><div class="smm-code-scroll"><p class="smm-code-line"><span class="token keyword">def</span> <span class="token function">f</span>():</p></div></div>',
        },
        children: [],
      },
    ],
  },
  layout: "logicalStructure",
};

const html = buildInteractiveHtml("测试导图", doc as never, umd);

// 只检查我们自己的静态 <style> 块（第一个），UMD 字符串里本来就有 quill 文本。
const headStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const checks = {
  cardCss: headStyle.includes(".smm-md-card") && headStyle.includes("smm-code-line"),
  tokenColors: headStyle.includes(".token.keyword"),
  katexRules: headStyle.includes(".katex-display"),
  noQuillCssEmbed: !headStyle.includes(".ql-container"),
  umdInlined: html.includes("webpackUniversalModuleDefinition"),
  scriptEscaped: !/<\/script\s*>\s*\(function webpackUniversalModuleDefinition/.test(html),
  scriptCloseCount: (html.match(/<\/script>/g) ?? []).length === 2,
  // doc 里的富文本 HTML（含 </div>）必须被转义成 \u003c，否则提前破栏。
  dataEscaped: html.includes("\\u003c/div>"),
};
console.log(JSON.stringify(checks));
const ok = Object.values(checks).every(Boolean);
if (!ok) process.exit(1);
