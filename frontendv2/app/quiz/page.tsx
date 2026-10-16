"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { QuizView } from "@/components/quiz/quiz-view";

/**
 * Quiz page - 题目练习列表. Keeps the top NavBar; the view owns the
 * list flow below the bar. quiz-scope 切换到 Google Material 3 视觉
 * （globals.css），仅作用于本页。
 * 查看具体题卷 = 动态路由 /quiz/[uuid]；旧深链 /quiz?quiz=<uuid> 在此
 * 兼容跳转（聊天页等历史入口）。
 */
export default function QuizPage() {
    const router = useRouter();
    useEffect(() => {
        const param = new URLSearchParams(window.location.search).get("quiz");
        if (param) router.replace(`/quiz/${param}`);
    }, [router]);

    return (
        <>
            <NavBar />
            <main className="quiz-scope flex flex-1 flex-col">
                <QuizView />
            </main>
        </>
    );
}
