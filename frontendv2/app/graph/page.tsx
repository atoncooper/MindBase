"use client";

import { use } from "react";
import { NavBar } from "@/components/nav-bar";
import { GraphView } from "@/components/kg/graph-view";

/**
 * Knowledge graph visualization page - a nav destination, so it KEEPS the
 * top NavBar. `?center=<eid>` deep-link centers the graph on that entity
 * (e.g. from the blindspot map).
 */
export default function GraphPage({
    searchParams,
}: {
    searchParams: Promise<{ center?: string }>;
}) {
    const { center } = use(searchParams);
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <GraphView initialCenter={center} />
            </main>
        </>
    );
}
