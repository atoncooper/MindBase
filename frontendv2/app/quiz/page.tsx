"use client";

import { NavBar } from "@/components/nav-bar";
import { QuizView } from "@/components/quiz/quiz-view";

/**
 * Quiz page - 题目练习. Keeps the top NavBar; the view owns the
 * list <-> taking <-> result flow below the bar. quiz-scope 切换到
 * Google Material 3 视觉（globals.css），仅作用于本页。
 */
export default function QuizPage() {
    return (
        <>
            <NavBar />
            <main className="quiz-scope flex flex-1 flex-col">
                <QuizView />
            </main>
        </>
    );
}
