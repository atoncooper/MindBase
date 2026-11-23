"use client";

import { NavBar } from "@/components/nav-bar";
import { OrdersView } from "@/components/orders/orders-view";

export default function Page() {
    return (
        <>
            <NavBar />
            <main className="flex-1">
                <OrdersView />
            </main>
        </>
    );
}
