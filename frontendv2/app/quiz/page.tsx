"use client";

import { NavBar } from "@/components/nav-bar";
import { QuizView } from "@/components/quiz/quiz-view";

/**
 * Quiz page - 题目练习. Keeps the top NavBar; the view owns the
 * list <-> taking <-> result flow below the bar.
 */
export default function QuizPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <QuizView />
            </main>
        </>
    );
}
