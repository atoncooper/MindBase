"use client";

import { NavBar } from "@/components/nav-bar";
import { MembershipView } from "@/components/membership/membership-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <MembershipView />
            </main>
        </>
    );
}
