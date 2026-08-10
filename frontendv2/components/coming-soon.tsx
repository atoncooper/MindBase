"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { NavBar } from "./nav-bar";

interface ComingSoonProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
}

/** Placeholder page for nav routes whose feature panel isn't migrated yet. */
export function ComingSoon({ title, description, icon: Icon }: ComingSoonProps) {
  return (
    <>
      <NavBar />
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.28, 0.11, 0.32, 1] }}
          className="flex flex-col items-center"
        >
          {Icon && (
            <div className="mb-6 grid h-16 w-16 place-items-center rounded-2xl border border-border bg-surface">
              <Icon className="h-7 w-7 text-secondary" />
            </div>
          )}
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground md:text-[40px]">
            {title}
          </h1>
          <p className="mt-3 max-w-[420px] text-[16px] text-secondary">
            {description ?? "该功能正在迁移到新版本，即将上线。"}
          </p>
          <Link
            href="/"
            className="btn-pill btn-ghost mt-8 h-10 px-5 text-[14px]"
          >
            <ArrowLeft className="h-4 w-4" />
            返回首页
          </Link>
        </motion.div>
      </main>
    </>
  );
}
