"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

// Center + child nodes of the mock mind map (SVG coords, viewBox 0 0 400 210)
const CENTER = { x: 200, y: 105, label: "学习方法" };
const CHILDREN = [
  { x: 62, y: 38, label: "费曼技巧" },
  { x: 60, y: 172, label: "间隔重复" },
  { x: 338, y: 42, label: "主动回忆" },
  { x: 336, y: 170, label: "笔记系统" },
];

const NOTE_LINES = [
  "费曼技巧：讲给外行听，卡壳处即盲点",
  "间隔重复：1/3/7 天复习节奏",
  "主动回忆：先默写再对照，而非重读",
];

/**
 * Looping mockup: a mind map grows out of its center (edges draw themselves,
 * nodes pop in) while note lines appear beneath, fade out, then regrow.
 * Loops via remount (runId) wrapped in a crossfade; pauses while off-screen;
 * renders the finished state under reduced motion.
 */
export function DemoMindmap() {
  const reduced = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(cardRef, { margin: "0px 0px -200px 0px" });
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (reduced || !inView) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(() => {
        if (cancelled) return;
        setRunId((r) => r + 1);
        schedule();
      }, 4600);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduced, inView]);

  return (
    <div
      ref={cardRef}
      className="rounded-2xl border border-border bg-surface p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_24px_70px_rgba(0,0,0,0.11)] md:p-5"
    >
      <div className="flex items-center gap-1.5 border-b border-border-subtle pb-3">
        <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
        <span className="text-[12px] font-medium text-foreground">思维导图 · 学习方法</span>
        <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">AI 生成</span>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={runId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: EASE_APPLE }}
        >
          <svg
            viewBox="0 0 400 210"
            className="h-auto w-full pt-2"
            role="img"
            aria-label="思维导图生长动画"
          >
            {CHILDREN.map((c, i) => {
              const mx = (CENTER.x + c.x) / 2;
              const d = `M ${CENTER.x} ${CENTER.y} Q ${mx} ${c.y < CENTER.y ? c.y + 12 : c.y - 12} ${c.x} ${c.y}`;
              return (
                <motion.path
                  key={`edge-${i}`}
                  d={d}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth={1.5}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.7, delay: 0.25 + i * 0.3, ease: EASE_APPLE }}
                />
              );
            })}

            {/* Center node */}
            <motion.g
              initial={reduced ? false : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: EASE_APPLE }}
              style={{ transformOrigin: `${CENTER.x}px ${CENTER.y}px` }}
            >
              <rect x={CENTER.x - 52} y={CENTER.y - 17} width={104} height={34} rx={17} className="fill-accent" />
              <text x={CENTER.x} y={CENTER.y + 4} textAnchor="middle" className="fill-surface text-[12px] font-medium">
                {CENTER.label}
              </text>
            </motion.g>

            {/* Child nodes pop in as their edge finishes drawing */}
            {CHILDREN.map((c, i) => (
              <motion.g
                key={`node-${i}`}
                initial={reduced ? false : { opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.45, delay: 0.7 + i * 0.3, ease: EASE_APPLE }}
                style={{ transformOrigin: `${c.x}px ${c.y}px` }}
              >
                <rect x={c.x - 44} y={c.y - 15} width={88} height={30} rx={15} className="fill-surface" stroke="var(--color-border)" strokeWidth={1.2} />
                <text x={c.x} y={c.y + 4} textAnchor="middle" className="fill-foreground text-[11px]">
                  {c.label}
                </text>
              </motion.g>
            ))}
          </svg>

          <div className="mt-2 border-t border-border-subtle pt-3">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-tertiary">笔记摘录</div>
            <div className="flex flex-col gap-1.5">
              {NOTE_LINES.map((line, i) => (
                <motion.div
                  key={line}
                  initial={reduced ? false : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 2.1 + i * 0.35, ease: EASE_APPLE }}
                  className="flex items-center gap-2 text-[12px] text-secondary"
                >
                  <span className="h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  {line}
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
