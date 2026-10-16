"use client";

import { useParams } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { QuizDetail } from "@/components/quiz/quiz-detail";

/**
 * Quiz detail page - 动态路由 /quiz/[uuid]：单份题卷的作答/生成中/结果视图。
 * URL 即状态：可刷新、可分享、浏览器前进后退可用；返回列表 = /quiz。
 */
export default function QuizDetailPage() {
    const params = useParams<{ uuid: string }>();
    const uuid = Array.isArray(params.uuid) ? params.uuid[0] : params.uuid;

    return (
        <>
            <NavBar />
            <main className="quiz-scope flex flex-1 flex-col">
                <QuizDetail quizUuid={uuid} />
            </main>
        </>
    );
}
