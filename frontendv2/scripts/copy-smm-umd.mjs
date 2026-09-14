/**
 * 把 simple-mind-map 的 UMD 全量包与样式从 node_modules 拷进 public/。
 *
 * 「导出交互式 HTML」需要这两个文件内嵌进产物（约 7MB）。桌面端经 Vite
 * `?raw` 在构建期内联；Turbopack 无 `?raw`，且 7MB 不宜进 JS bundle——改为
 * 构建时拷进 public/（静态资源），导出时同源 fetch 取文本。文件由本脚本
 * 生成，不入 git（见 .gitignore），`prebuild` 钩子自动执行。
 */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "node_modules", "simple-mind-map", "dist");
const out = join(root, "public", "simple-mind-map");

const FILES = ["simpleMindMap.umd.min.js", "simpleMindMap.esm.min.css"];

mkdirSync(out, { recursive: true });
for (const name of FILES) {
  const src = join(dist, name);
  copyFileSync(src, join(out, name));
  console.log(`[copy-smm-umd] ${name} (${Math.round(statSync(src).size / 1024)} KB)`);
}
