/* KaTeX-in-MD-card smoke test: renders inline/block formulas through the same
 * pipeline the canvas uses (renderToStaticMarkup), checks KaTeX output and
 * error fallback. Run: npx tsx scripts/dev/md-katex-smoke.mts
 *
 * Note: remark-math v6 treats single-line $$...$$ as inline math (same as the
 * shared chat renderer); block-level katex-display requires $$ on its own line.
 */
import { renderMdCardHtml } from "../../components/mindmap/editor/mdCard";

const md = [
  "行内质能方程 $E=mc^2$ 与欧拉公式 $e^{i\\pi}+1=0$。",
  "",
  "$$",
  "\\int_a^b f(x)\\,dx = F(b)-F(a)",
  "$$",
  "",
  "坏公式 $\\frac{坏$ 应回显不崩。",
].join("\n");

const html = renderMdCardHtml(md);
const checks = {
  katexSpan: html.includes("katex"),
  inlineRendered: html.includes("E=mc"),
  blockRendered: html.includes("katex-display"),
  errorFallback: html.includes("katex-error"),
  noScript: !/<script/i.test(html),
};
console.log(JSON.stringify(checks));
const ok = checks.katexSpan && checks.inlineRendered && checks.blockRendered && checks.errorFallback && checks.noScript;
if (!ok) process.exit(1);
