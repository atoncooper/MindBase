"use client";

import { NavBar } from "@/components/nav-bar";
import { TasksView } from "@/components/tasks/tasks-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <TasksView />
            </main>
        </>
    );
}
