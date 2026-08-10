"use client";

import { NavBar } from "@/components/nav-bar";
import { UsageView } from "@/components/billing/usage-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <UsageView />
            </main>
        </>
    );
}
