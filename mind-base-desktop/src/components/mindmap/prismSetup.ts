/**
 * Prism 全局挂载：prismjs 的语言组件（components/prism-*）在执行时引用的
 * 是全局 `Prism` 变量，而 Vite 的 CJS→ESM 互转不保证核心模块把它挂到
 * globalThis——组件导入前必须先执行本模块。用法：
 *
 *   import Prism from "./prismSetup";
 *   import "prismjs/components/prism-xxx";
 */

import Prism from "prismjs";

(globalThis as { Prism?: unknown }).Prism = Prism;

export default Prism;
