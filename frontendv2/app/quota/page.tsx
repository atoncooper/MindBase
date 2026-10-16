"use client";

import { NavBar } from "@/components/nav-bar";
import { QuotaView } from "@/components/quota/quota-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <QuotaView />
            </main>
        </>
    );
}
