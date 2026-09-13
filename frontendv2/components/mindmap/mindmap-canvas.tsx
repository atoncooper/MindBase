"use client";

/**
 * simple-mind-map 的只读 React 封装（P1：仅渲染 + 缩放/平移）。
 *
 * 库是命令式的：构造即渲染、自持 SVG 画布。StrictMode 双挂载下 init/destroy
 * 必须严格成对（destroy + 清空容器），否则画布会叠两层（对齐桌面端实现）。
 * 只读模式不注册任何插件（拖拽/富文本等编辑插件留待 P2 编辑器移植）。
 *
 * 本组件直接操作 DOM，必须经 next/dynamic({ ssr: false }) 加载。
 */

import { useEffect, useRef } from "react";
import MindMap from "simple-mind-map";
import type { MindMapDoc } from "./mindmap-doc";

interface MindMapCanvasProps {
    doc: MindMapDoc;
    className?: string;
}

function MindMapCanvas({ doc, className }: MindMapCanvasProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (el === null) return;

        const instance = new MindMap({
            el,
            data: doc.root,
            layout: doc.layout ?? "logicalStructure",
            theme: "default",
            fit: true,
            readonly: true,
            // 滚轮直接缩放（与桌面端一致）。
            mousewheelAction: "zoom",
        });
        if (doc.theme?.config !== undefined) {
            instance.setThemeConfig(doc.theme.config);
        }

        const onResize = () => instance.resize();
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            instance.destroy();
            el.innerHTML = "";
        };
    }, [doc]);

    return <div ref={containerRef} className={className} />;
}

export default MindMapCanvas;
