"use client";

import { ComingSoon } from "@/components/coming-soon";
import { navItems } from "@/lib/nav-config";

const item = navItems.find((i) => i.id === "tasks")!;

export default function Page() {
  return <ComingSoon title={item.label} icon={item.icon} />;
}
