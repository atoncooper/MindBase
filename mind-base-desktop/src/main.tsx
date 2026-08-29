import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted typefaces (CSP forbids remote fonts): Geist Sans for UI text,
// Geist Mono for paths, versions, badges and micro-labels.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
// 霞鹜文楷屏幕版（GB 常用字子集，按 unicode-range 分片按需加载）——
// 仅用于笔记编辑/预览的书写面，UI 仍保持 Geist。
import "lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css";
import App from "./App";
import { ToastProvider } from "./lib/toast";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
