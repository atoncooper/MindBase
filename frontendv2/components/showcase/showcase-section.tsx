"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

const revealContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};
const revealItem = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_APPLE } },
};

export interface ShowcaseCta {
  label: string;
  /** Authed CTA: internal link to the feature page. */
  href?: string;
  /** Anonymous CTA: opens the login modal. */
  onClick?: () => void;
}

interface ShowcaseSectionProps {
  eyebrow: string;
  title: ReactNode;
  description: string;
  bullets: string[];
  /** Animated demo rendered on the opposite side of the copy. */
  visual: ReactNode;
  /** Visual left / copy right (sections alternate). Default: copy left. */
  flip?: boolean;
  /** Full-bleed band background; alternate per section. Default "light". */
  tone?: "light" | "gray";
  cta?: ShowcaseCta;
}

/**
 * Apple-style alternating showcase band: copy on one side, an animated
 * product demo on the other, revealed on scroll. Stacks vertically on mobile
 * (copy above visual).
 */
export function ShowcaseSection({
  eyebrow,
  title,
  description,
  bullets,
  visual,
  flip = false,
  tone = "light",
  cta,
}: ShowcaseSectionProps) {
  return (
    <div className={tone === "gray" ? "bg-[#f5f5f7]" : "bg-surface"}>
      <div className="mx-auto grid w-full max-w-[1100px] items-center gap-12 px-6 py-20 md:grid-cols-2 md:gap-16 md:py-28">
        {/* Copy */}
        <motion.div
          variants={revealContainer}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className={flip ? "md:order-2" : undefined}
        >
          <motion.span variants={revealItem} className="text-[13px] font-medium text-accent">
            {eyebrow}
          </motion.span>
          <motion.h2
            variants={revealItem}
            className="mt-3 text-[28px] font-semibold leading-[1.12] tracking-tight text-foreground md:text-[38px]"
          >
            {title}
          </motion.h2>
          <motion.p
            variants={revealItem}
            className="mt-4 max-w-[440px] text-[15px] leading-relaxed text-secondary md:text-[17px]"
          >
            {description}
          </motion.p>
          <motion.ul variants={revealItem} className="mt-6 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-[14px] text-secondary md:text-[15px]">
                <span className="mt-0.5 grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <Check className="h-3 w-3" aria-hidden="true" />
                </span>
                {b}
              </li>
            ))}
          </motion.ul>
          {cta && (
            <motion.div variants={revealItem} className="mt-8">
              {cta.href ? (
                <Link href={cta.href} className="btn-pill btn-primary inline-flex h-10 items-center gap-1.5 px-5 text-[14px]">
                  {cta.label}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              ) : (
                <button onClick={cta.onClick} className="btn-pill btn-primary inline-flex h-10 items-center gap-1.5 px-5 text-[14px]">
                  {cta.label}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </motion.div>
          )}
        </motion.div>

        {/* Animated demo - purely decorative for assistive tech (the copy
            carries the meaning); soft glow behind the card adds depth. */}
        <motion.div
          variants={revealItem}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className={flip ? "md:order-1" : undefined}
        >
          <div className="relative mx-auto w-full max-w-[500px]">
            <div
              aria-hidden="true"
              className="absolute -inset-8 -z-10 rounded-[36px] bg-[radial-gradient(closest-side,rgba(0,113,227,0.07),transparent)]"
            />
            <div aria-hidden="true">{visual}</div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
