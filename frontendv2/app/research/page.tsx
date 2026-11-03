"use client";

import { NavBar } from "@/components/nav-bar";
import { ResearchView } from "@/components/research/research-view";

/**
 * 科研工作台页面（plan/1.0.17 Phase 2 前端）：与其它导航页一致保留顶部 NavBar，
 * 视图在下方铺开（左项目列表 + 右详情/四 Tab）。
 */
export default function ResearchPage() {
    return (
        <>
            <NavBar />
            <main className="flex min-h-0 flex-1 flex-col">
                <ResearchView />
            </main>
        </>
    );
}
