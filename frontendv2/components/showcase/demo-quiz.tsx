"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { AlarmClock, Check, CircleCheck } from "lucide-react";

const QUESTION = "根据已学内容：费曼技巧中「卡壳」意味着什么？";
const OPTIONS = [
  { text: "讲得不够流利，需要多练习表达", correct: false },
  { text: "这个概念还没真正理解，回去重新学", correct: true },
  { text: "听讲的人理解能力有问题", correct: false },
  { text: "应该换一个更简单的概念来讲", correct: false },
];

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

/**
 * Looping mockup: an AI-generated quiz card appears, options scan one by one,
 * the correct answer lights up green with a pass badge; a scheduled-task card
 * with a countdown ring sits beside it. Crossfades between loop cycles;
 * pauses while off-screen; static done-state under reduced motion.
 */
export function DemoQuiz() {
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inView = useInView(wrapRef, { margin: "0px 0px -200px 0px" });
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
      }, 5600);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduced, inView]);

  return (
    <div ref={wrapRef}>
      <AnimatePresence mode="wait">
        <motion.div
          key={runId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: EASE_APPLE }}
          className="flex flex-col gap-3"
        >
      {/* Scheduled task card with countdown ring */}
      <div className="flex items-center gap-3 self-end rounded-2xl border border-border bg-surface px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.06)]">
        <CountdownRing reduced={!!reduced} />
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <AlarmClock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            定时出题 · 每天 21:00
          </div>
          <div className="text-[11px] text-tertiary">来自知识库「学习方法」· 5 道题</div>
        </div>
      </div>

      {/* Quiz card */}
      <div className="rounded-2xl border border-border bg-surface p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] md:p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">AI 出题</span>
          <span className="text-[10px] text-tertiary">第 2 / 5 题</span>
        </div>
        <p className="text-[13px] font-medium leading-relaxed text-foreground">{QUESTION}</p>

        <div className="mt-3 flex flex-col gap-2">
          {OPTIONS.map((opt, i) => (
            <motion.div
              key={opt.text}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: reduced ? 0 : 0.3 + i * 0.45, ease: EASE_APPLE }}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-[12px] transition-colors duration-300 ${
                opt.correct
                  ? "border-success/40 bg-success/10 text-foreground"
                  : "border-border-subtle bg-background text-secondary"
              }`}
            >
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-medium ${
                  opt.correct ? "bg-success text-surface" : "bg-border-subtle text-tertiary"
                }`}
              >
                {opt.correct ? <Check className="h-3 w-3" aria-hidden="true" /> : String.fromCharCode(65 + i)}
              </span>
              {opt.text}
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={reduced ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, delay: reduced ? 0 : 2.4, ease: EASE_APPLE }}
          className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-success"
        >
          <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
          回答正确 · 已加入复习计划
        </motion.div>
      </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// SVG countdown ring that fills over ~2.5s on each loop run
function CountdownRing({ reduced }: { reduced: boolean }) {
  return (
    <svg viewBox="0 0 36 36" className="h-9 w-9 shrink-0" role="img" aria-label="倒计时">
      <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--color-border-subtle)" strokeWidth="3" />
      <motion.circle
        cx="18"
        cy="18"
        r="15.5"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={2 * Math.PI * 15.5}
        transform="rotate(-90 18 18)"
        initial={reduced ? false : { strokeDashoffset: 2 * Math.PI * 15.5 }}
        animate={{ strokeDashoffset: reduced ? 12 : 2 * Math.PI * 15.5 * 0.15 }}
        transition={{ duration: reduced ? 0 : 2.5, ease: "linear" }}
      />
      <text x="18" y="21.5" textAnchor="middle" className="fill-foreground text-[9px] font-medium">
        21:00
      </text>
    </svg>
  );
}
