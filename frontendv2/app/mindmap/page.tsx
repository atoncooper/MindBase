"use client";

import { NavBar } from "@/components/nav-bar";
import { MindMapView } from "@/components/mindmap/mindmap-view";

/**
 * 思维导图页 - 左列表（导图/白板）+ 右完整编辑器（桌面端移植，含白板
 * Excalidraw）。
 */
export default function MindMapPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <MindMapView />
            </main>
        </>
    );
}
