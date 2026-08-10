"use client";

import { NavBar } from "@/components/nav-bar";
import { SettingsView } from "@/components/settings/settings-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <SettingsView />
            </main>
        </>
    );
}
