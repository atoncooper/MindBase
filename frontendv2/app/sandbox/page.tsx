"use client";

import { NavBar } from "@/components/nav-bar";
import { SandboxView } from "@/components/sandbox/sandbox-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <SandboxView />
            </main>
        </>
    );
}
