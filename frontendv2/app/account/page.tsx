"use client";

import { NavBar } from "@/components/nav-bar";
import { AccountView } from "@/components/account/account-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <AccountView />
            </main>
        </>
    );
}
