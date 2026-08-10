"use client";

import { NavBar } from "@/components/nav-bar";
import { SkillsView } from "@/components/skills/skills-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <SkillsView />
            </main>
        </>
    );
}
