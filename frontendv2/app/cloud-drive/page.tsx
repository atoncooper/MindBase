"use client";

import { NavBar } from "@/components/nav-bar";
import { CloudDriveView } from "@/components/cloud-drive/cloud-drive-view";

/**
 * Cloud drive page - a nav destination. Keeps the top NavBar; the view fills
 * the viewport below the bar (h-12) with a folder sidebar + file list/grid +
 * right inspector.
 */
export default function CloudDrivePage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <CloudDriveView />
            </main>
        </>
    );
}
