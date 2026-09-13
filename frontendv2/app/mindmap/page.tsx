"use client";

import { NavBar } from "@/components/nav-bar";
import { MindMapView } from "@/components/mindmap/mindmap-view";

/**
 * 思维导图页 - 左列表 + 右只读画布；编辑器（P2）从桌面端移植后替换右侧。
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
