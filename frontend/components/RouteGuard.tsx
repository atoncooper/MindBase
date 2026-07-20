"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/**
 * Public routes that do NOT require authentication.
 *
 * Everything else is treated as protected (fail-closed): any new route is
 * guarded by default until explicitly added here. The home page "/" is public
 * because it doubles as the login entry (it renders its own hero/login UI when
 * unauthenticated, and the app shell when authenticated).
 */
const PUBLIC_EXACT = ["/"];
const PUBLIC_PREFIXES = [
  "/forgot-password",
  "/reset-password",
  "/notes/shared",
  "/quiz/share-view",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Global route guard. Renders a placeholder (never the protected content) while
 * auth state is loading or during the redirect to "/", so protected UI never
 * flashes for unauthenticated users. Public routes pass through untouched.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = isPublicPath(pathname ?? "/");

  useEffect(() => {
    if (status === "unauthenticated" && !isPublic) {
      router.replace("/");
    }
  }, [status, isPublic, router]);

  if (!isPublic && status !== "authenticated") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--gemini-surface)]">
        <span className="text-sm opacity-60">加载中…</span>
      </div>
    );
  }

  return <>{children}</>;
}
