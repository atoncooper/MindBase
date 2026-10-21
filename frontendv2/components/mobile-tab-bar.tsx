"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { LayoutGrid, LogOut, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { navItems, primaryNavItems } from "@/lib/nav-config";

// Bottom tab bar: the 4 highest-frequency destinations + a "更多" sheet.
const TAB_IDS = ["chat", "favorites", "notes", "cloud-drive"] as const;

const mobileTabs = TAB_IDS.map((id) => primaryNavItems.find((i) => i.id === id)).filter(
  (i) => i !== undefined
);

// Sheet lists every destination not pinned to the tab bar, plus the account
// rows (settings / profile) and logout - mirrors the desktop nav grouping.
const sheetFeatureItems = navItems.filter(
  (i) => !(TAB_IDS as readonly string[]).includes(i.id) && i.placement !== "account"
);
const sheetAccountItems = navItems.filter((i) => i.placement === "account");

/**
 * 移动端底部导航（md:hidden）：4 个高频 tab + 「更多」底部 sheet。
 * 仅登录后渲染；由 NavBar 以 header 兄弟节点挂载（header 的 backdrop-filter
 * 会创建 fixed 包含块，不能放进 header 内部）。
 */
export function MobileTabBar() {
  const { status, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  // 路由变化（含系统返回手势）一律收起 sheet。
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  // sheet 打开时锁定 body 滚动；视口回到桌面宽度时自动收起，避免残留滚动锁。
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const mq = window.matchMedia("(min-width: 768px)");
    const onDesktop = () => {
      if (mq.matches) setSheetOpen(false);
    };
    mq.addEventListener("change", onDesktop);
    return () => {
      document.body.style.overflow = prev;
      mq.removeEventListener("change", onDesktop);
    };
  }, [sheetOpen]);

  if (status !== "authenticated") return null;

  const handleLogout = async () => {
    setSheetOpen(false);
    await logout();
    router.push("/");
  };

  return (
    <>
      {/* 「更多」底部 sheet */}
      <AnimatePresence>
        {sheetOpen && (
          <>
            <motion.button
              aria-label="关闭菜单"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setSheetOpen(false)}
              className="fixed inset-0 z-[55] bg-black/30 md:hidden"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ duration: 0.32, ease: [0.28, 0.11, 0.32, 1] }}
              className="fixed inset-x-0 bottom-0 z-[60] max-h-[72vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface shadow-[0_-12px_40px_rgba(0,0,0,0.14)] md:hidden"
            >
              <div className="sticky top-0 flex items-center justify-between border-b border-border-subtle bg-surface/95 px-5 py-3.5 backdrop-blur">
                <p className="text-[14px] font-semibold tracking-tight text-foreground">
                  全部功能
                </p>
                <button
                  onClick={() => setSheetOpen(false)}
                  aria-label="关闭"
                  className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors active:bg-border-subtle"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1 px-3 py-4">
                {sheetFeatureItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      onClick={() => setSheetOpen(false)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 transition-colors active:bg-border-subtle",
                        active ? "text-accent" : "text-foreground/90"
                      )}
                    >
                      <Icon className="h-5 w-5" />
                      <span className="text-[11px] leading-none">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
              <div className="border-t border-border-subtle px-2 py-2">
                {sheetAccountItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      onClick={() => setSheetOpen(false)}
                      className="flex items-center gap-2.5 rounded-xl px-3 py-3 text-[13px] text-foreground/90 transition-colors active:bg-border-subtle"
                    >
                      <Icon className="h-[18px] w-[18px] text-secondary" />
                      {item.label}
                    </Link>
                  );
                })}
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-[13px] text-danger transition-colors active:bg-danger/5"
                >
                  <LogOut className="h-[18px] w-[18px]" />
                  退出登录
                </button>
              </div>
              {/* iOS home indicator 呼吸空间 */}
              <div className="pb-[env(safe-area-inset-bottom)]" />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* 底部 tab bar */}
      <nav
        aria-label="移动端主导航"
        className="mobile-tab-bar fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface/90 backdrop-blur saturate-150 md:hidden"
      >
        <div className="grid h-15 grid-cols-5">
          {mobileTabs.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 transition-colors",
                  active ? "text-accent" : "text-secondary"
                )}
              >
                <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.2 : 1.8} />
                <span className={cn("text-[10px] leading-none", active && "font-medium")}>
                  {item.label}
                </span>
              </Link>
            );
          })}
          <button
            onClick={() => setSheetOpen((v) => !v)}
            aria-expanded={sheetOpen}
            aria-label="更多功能"
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 transition-colors",
              sheetOpen ? "text-accent" : "text-secondary"
            )}
          >
            <LayoutGrid className="h-[22px] w-[22px]" strokeWidth={sheetOpen ? 2.2 : 1.8} />
            <span className="text-[10px] leading-none">更多</span>
          </button>
        </div>
        <div className="pb-[env(safe-area-inset-bottom)]" />
      </nav>
    </>
  );
}
