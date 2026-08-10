"use client";

import { NavBar } from "@/components/nav-bar";
import { FavoritesView } from "@/components/favorites/favorites-view";

/**
 * Favorites page - a nav destination, so it KEEPS the top NavBar (unlike /chat
 * which is an immersive full-screen surface). Layout mirrors other nav pages:
 * NavBar + centered content shell.
 */
export default function FavoritesPage() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <FavoritesView />
            </main>
        </>
    );
}
