/**
 * 动态分包边界：把 Excalidraw 的组件与样式聚在一个模块里（与桌面端一致），
 * 编辑器运行时 `import()` 本模块即可（约 1-2MB 的实现与 CSS 单独成 chunk）。
 * 业务代码不要静态 import @excalidraw/excalidraw。
 */

import "@excalidraw/excalidraw/index.css";

export * from "@excalidraw/excalidraw";
