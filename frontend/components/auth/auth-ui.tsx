"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

export const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};

export const itemVariants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

/**
 * Two-column auth shell: a tinted brand panel (left on desktop, top on mobile)
 * and a centered form panel. Both columns run staggered enter animations.
 */
export function AuthLayout({ brand, children }: { brand: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--gemini-surface)] text-[var(--gemini-text-primary)] md:flex-row">
      <motion.aside
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="relative flex flex-col justify-between overflow-hidden bg-[var(--gemini-surface-variant)] p-8 md:w-[44%] md:min-h-screen md:p-14"
      >
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-[var(--gemini-primary)] opacity-[0.07] blur-2xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-12 h-80 w-80 rounded-full bg-[var(--gemini-primary)] opacity-[0.05] blur-3xl" />
        {brand}
      </motion.aside>
      <main className="flex flex-1 items-center justify-center p-6 md:p-10">
        <motion.div variants={containerVariants} initial="hidden" animate="show" className="w-full max-w-[420px]">
          {children}
        </motion.div>
      </main>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={`h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin ${className ?? ""}`} />;
}

export function CheckIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function AlertIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zM9 5a1 1 0 112 0v6a1 1 0 11-2 0V5zm1 10a1.25 1.25 0 100-2.5A1.25 1.25 0 0010 15z" clipRule="evenodd" />
    </svg>
  );
}

export function CheckSmall() {
  return (
    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function SuccessCard({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <motion.div
      variants={itemVariants}
      className="rounded-[var(--gemini-radius-sm)] border border-[var(--gemini-border-subtle)] bg-[var(--gemini-surface)] p-8 shadow-[var(--gemini-shadow-md)]"
    >
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.12, type: "spring", stiffness: 220, damping: 16 }}
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#e6f4ea] text-[#1e8e3e] dark:bg-[#1e2920] dark:text-[#81c995]"
      >
        <CheckIcon />
      </motion.div>
      <h2 className="text-[22px] font-normal text-[var(--gemini-text-primary)]">{title}</h2>
      {desc && <div className="mt-3 text-[14px] leading-[1.6] text-[var(--gemini-text-secondary)]">{desc}</div>}
      {children}
    </motion.div>
  );
}

export function ErrorCard({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <motion.div
      variants={itemVariants}
      className="rounded-[var(--gemini-radius-sm)] border border-[var(--gemini-border-subtle)] bg-[var(--gemini-surface)] p-8 shadow-[var(--gemini-shadow-md)]"
    >
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#fce8e6] text-[#d93025] dark:bg-[#2a1a1a] dark:text-[#f28b82]">
        <AlertIcon className="h-6 w-6" />
      </div>
      <h2 className="text-[22px] font-normal text-[var(--gemini-text-primary)]">{title}</h2>
      {desc && <div className="mt-3 text-[14px] leading-[1.6] text-[var(--gemini-text-secondary)]">{desc}</div>}
      {children}
    </motion.div>
  );
}
