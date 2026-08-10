"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { primaryNavItems, moreNavItems, accountNavItems } from "@/lib/nav-config";

interface NavBarProps {
  onLoginClick?: () => void;
}

export function NavBar({ onLoginClick }: NavBarProps) {
  const { status, user, uid, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isAuthed = status === "authenticated";

  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      // More panel closes when clicking outside both the toggle and the panel.
      if (
        moreRef.current && !moreRef.current.contains(t) &&
        panelRef.current && !panelRef.current.contains(t)
      ) setMoreOpen(false);
      if (accountRef.current && !accountRef.current.contains(t)) setAccountOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="nav-blur sticky top-0 z-50">
      <nav className="mx-auto flex h-12 max-w-[1100px] items-center justify-between px-5">
        {/* Brand */}
        <Link
          href="/"
          className="text-[15px] font-semibold tracking-tight text-foreground"
        >
          MindBase
        </Link>

        {/* Primary nav items - only when authed (landing keeps the bar minimal) */}
        {isAuthed && (
          <div className="hidden items-center gap-7 md:flex">
            {primaryNavItems.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={cn("nav-link text-[12px]", isActive(item.href) && "font-medium opacity-100")}
              >
                {item.label}
              </Link>
            ))}

            {/* 更多 toggle - expands a full-width strip below the nav (Apple-style) */}
            <div ref={moreRef}>
              <button
                onClick={() => setMoreOpen((v) => !v)}
                className="nav-link flex items-center gap-0.5 text-[12px]"
              >
                更多
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform duration-200",
                    moreOpen && "rotate-180"
                  )}
                />
              </button>
            </div>
          </div>
        )}

        {/* Right: auth area */}
        <div className="flex items-center gap-2">
          {!isAuthed ? (
            <button
              onClick={onLoginClick}
              className="btn-pill btn-primary h-8 px-4 text-[12px]"
            >
              登录
            </button>
          ) : (
            <div className="flex items-center gap-1">
              {accountNavItems
                .filter((i) => i.id === "settings")
                .map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      title={item.label}
                      className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                      <Icon className="h-[18px] w-[18px]" />
                    </Link>
                  );
                })}

              {/* Account menu */}
              <div ref={accountRef} className="relative">
                <button
                  onClick={() => setAccountOpen((v) => !v)}
                  aria-expanded={accountOpen}
                  aria-label="账户菜单"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1.5 transition-colors",
                    accountOpen ? "bg-border-subtle" : "hover:bg-border-subtle"
                  )}
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[12px] font-semibold text-white ring-1 ring-black/[0.06]">
                    {(user ?? "?").slice(0, 1)}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 text-tertiary transition-transform duration-200",
                      accountOpen && "rotate-180"
                    )}
                  />
                </button>
                <AnimatePresence>
                  {accountOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      transition={{ duration: 0.2, ease: [0.28, 0.11, 0.32, 1] }}
                      className="absolute right-0 top-[calc(100%+12px)] w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)]"
                    >
                      {/* Header - Apple ID style: avatar + name + uid */}
                      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-[15px] font-semibold text-white ring-1 ring-black/[0.06]">
                          {(user ?? "?").slice(0, 1)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[14px] font-medium tracking-tight text-foreground">
                            {user ?? "用户"}
                          </p>
                          <p className="text-[11px] text-secondary">
                            {uid ? `UID: ${uid}` : "已登录"}
                          </p>
                        </div>
                      </div>
                      {/* Menu items */}
                      {accountNavItems
                        .filter((i) => i.id === "account")
                        .map((item) => {
                          const Icon = item.icon;
                          return (
                            <Link
                              key={item.id}
                              href={item.href}
                              onClick={() => setAccountOpen(false)}
                              className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-foreground/90 transition-colors hover:bg-border-subtle"
                            >
                              <Icon className="h-[18px] w-[18px] text-secondary" />
                              {item.label}
                            </Link>
                          );
                        })}
                      <button
                        onClick={async () => {
                          setAccountOpen(false);
                          await logout();
                          router.push("/");
                        }}
                        className="flex w-full items-center gap-2.5 border-t border-border-subtle px-4 py-2.5 text-[13px] text-danger transition-colors hover:bg-danger/5"
                      >
                        <LogOut className="h-[18px] w-[18px]" />
                        退出登录
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* 更多 expanding strip - Apple-style full-width panel that extends the
          nav bar downward; items laid out horizontally, centered. */}
      <AnimatePresence initial={false}>
        {moreOpen && (
          <motion.div
            ref={panelRef}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.28, 0.11, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-auto flex max-w-[1100px] items-center gap-7 border-b border-border-subtle px-5 py-5">
              {moreNavItems.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "text-[13px] font-medium transition-colors",
                    isActive(item.href) ? "text-accent" : "text-foreground hover:text-accent"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
