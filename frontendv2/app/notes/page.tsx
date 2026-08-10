"use client";

import { NavBar } from "@/components/nav-bar";
import { NotesView } from "@/components/notes/notes-view";

/**
 * Notes page - a nav destination, keeps the top NavBar. The view fills the
 * viewport below the bar (h-12) with a left list + right editor.
 */
export default function NotesPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <NotesView />
            </main>
        </>
    );
}
