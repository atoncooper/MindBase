"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { primaryNavItems, moreNavItems } from "@/lib/nav-config";
import { AnimatedVisual } from "./animated-visual";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
};
const item = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.28, 0.11, 0.32, 1] as const } },
};

/** Logged-in landing: greeting + quick access to all modules + animated visual. */
export function DashboardShell() {
  const { user } = useAuth();
  const quickLinks = [...primaryNavItems, ...moreNavItems];

  return (
    <main className="relative flex flex-1 flex-col">
      <div className="absolute inset-x-0 top-0">
        <AnimatedVisual />
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="relative mx-auto w-full max-w-[1000px] px-6 pt-16 md:pt-20"
      >
        <motion.span variants={item} className="text-[13px] text-secondary">
          欢迎回来
        </motion.span>
        <motion.h1 variants={item} className="display-hero mt-2 text-[36px] text-foreground md:text-[52px]">
          {user ?? "用户"}，<br className="hidden md:block" />
          <span className="text-gradient-ink">继续构建你的知识库</span>
        </motion.h1>
        <motion.p variants={item} className="mt-5 max-w-[520px] text-[16px] leading-relaxed text-secondary md:text-[18px]">
          从顶部导航进入任意功能。对话检索、整理收藏、笔记回顾、定时出题——都在 MindBase 里。
        </motion.p>

        {/* Quick access grid */}
        <motion.div
          variants={container}
          className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-5"
        >
          {quickLinks.map((mod) => {
            const Icon = mod.icon;
            return (
              <motion.div key={mod.id} variants={item}>
                <Link
                  href={mod.href}
                  className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface p-5 transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)]"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-border-subtle text-foreground transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-medium text-foreground">{mod.label}</h3>
                    <p className="mt-0.5 text-[12px] text-secondary">进入 ›</p>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>
      </motion.div>

      <div className="flex-1" />
    </main>
  );
}
