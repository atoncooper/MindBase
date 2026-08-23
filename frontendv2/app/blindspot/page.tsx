"use client";

import { NavBar } from "@/components/nav-bar";
import { BlindspotView } from "@/components/blindspot/blindspot-view";

/**
 * Blindspot page - a nav destination, so it KEEPS the top NavBar.
 * Layout mirrors other nav pages: NavBar + centered content shell.
 */
export default function BlindspotPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <BlindspotView />
            </main>
        </>
    );
}
