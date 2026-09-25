"use client";

import { FeatureShowcase } from "./showcase/feature-showcase";

/**
 * Logged-in homepage: the alternating feature showcase with in-app CTAs.
 * The former greeting + quick-access grid duplicated the top navigation,
 * so it was removed - every module stays reachable from the nav bar.
 */
export function DashboardShell() {
  return (
    <main className="flex flex-1 flex-col">
      <FeatureShowcase authed />
    </main>
  );
}
