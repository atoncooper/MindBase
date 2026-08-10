"use client";

import { NavBar } from "@/components/nav-bar";
import { TaskQuizView } from "@/components/task-quiz/task-quiz-view";

/**
 * Task-quiz page - a nav destination, keeps the top NavBar. The view fills the
 * viewport below the bar (h-12) with a left task list + right detail/answer.
 */
export default function TaskQuizPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <TaskQuizView />
            </main>
        </>
    );
}
