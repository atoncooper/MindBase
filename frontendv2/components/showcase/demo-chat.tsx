"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { Brain, Check, ExternalLink } from "lucide-react";

const QUESTION = "费曼技巧到底是什么？怎么用在复习上？";
const ANSWER =
  "费曼技巧的核心是「用最简单的话讲给外行听」：先假装把概念讲给一个完全不懂的人，卡壳的地方就是你没真正学会的地方，回到材料重新理解，再简化重讲。复习时可以每学完一章，用自己的话写三句话摘要，讲不出来就回去补。";
const SOURCES = [
  { title: "【学习方法】费曼技巧的真正用法", meta: "bilibili.com · 12:30" },
  { title: "顶尖学生的学习系统全解析", meta: "bilibili.com · 03:15" },
];

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

const pop = {
  initial: { opacity: 0, y: 14, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: EASE_APPLE } },
};

/**
 * Looping RAG-chat mockup: user bubble → thinking chip → streaming answer →
 * cited source cards, fade out, then restart. Pauses while off-screen;
 * static final frame under reduced motion.
 */
export function DemoChat() {
  const reduced = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  // Only run the animation loop while near the viewport.
  const inView = useInView(cardRef, { margin: "0px 0px -200px 0px" });
  // 1 = user bubble, 2 = thinking chip, 3 = streaming, 4 = sources, 5 = fade out.
  // Reduced motion derives the finished frame at render time (no setState
  // in effect).
  const [phase, setPhase] = useState(0);
  const [chars, setChars] = useState(0);
  const shownPhase = reduced ? 4 : phase;
  const shownChars = reduced ? ANSWER.length : chars;

  useEffect(() => {
    if (reduced || !inView) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    (async () => {
      while (!cancelled) {
        setPhase(1);
        setChars(0);
        await wait(700);
        if (cancelled) return;
        setPhase(2);
        await wait(1300);
        if (cancelled) return;
        setPhase(3);
        for (let i = 2; i <= ANSWER.length; i += 2) {
          if (cancelled) return;
          setChars(i);
          await wait(26);
        }
        if (cancelled) return;
        setChars(ANSWER.length);
        setPhase(4);
        await wait(3600);
        if (cancelled) return;
        setPhase(5);
        await wait(500);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduced, inView]);

  const streaming = shownPhase === 3;
  const showSources = shownPhase >= 4;

  return (
    <div
      ref={cardRef}
      className="rounded-2xl border border-border bg-surface p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_24px_70px_rgba(0,0,0,0.11)] md:p-5"
    >
      {/* Fake window header */}
      <div className="flex items-center gap-1.5 border-b border-border-subtle pb-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-[11px] text-tertiary">MindBase · 对话</span>
      </div>

      {/* Fixed min-height keeps the card from jumping between loop cycles;
          the whole conversation fades out before each restart. */}
      <motion.div
        animate={{ opacity: shownPhase === 5 ? 0 : 1 }}
        transition={{ duration: 0.4, ease: EASE_APPLE }}
        className="flex min-h-[360px] flex-col gap-3 pt-4"
      >
        {shownPhase >= 1 && (
          <motion.div {...pop} className="ml-auto max-w-[85%] rounded-[16px] rounded-br-sm bg-[#dce8fb] px-3.5 py-2 text-[13px] leading-relaxed text-foreground">
            {QUESTION}
          </motion.div>
        )}

        {shownPhase >= 2 && (
          <motion.div {...pop} className="flex items-center gap-1.5 self-start rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-secondary">
            <Brain className={`h-3 w-3 text-accent ${shownPhase === 2 ? "animate-pulse" : ""}`} aria-hidden="true" />
            已深度思考 · 2 步
          </motion.div>
        )}

        {shownPhase >= 3 && (
          <div className="max-w-[92%] self-start text-[13px] leading-relaxed text-foreground">
            {ANSWER.slice(0, shownChars)}
            {streaming && <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-accent align-middle" aria-hidden="true" />}
          </div>
        )}

        {showSources && (
          <div className="mt-1 flex flex-col gap-2">
            {SOURCES.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.45, delay: i * 0.18, ease: EASE_APPLE }}
                className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-background px-3 py-2"
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-foreground">{s.title}</span>
                  <span className="text-[10px] text-tertiary">{s.meta}</span>
                </span>
                <ExternalLink className="h-3 w-3 shrink-0 text-tertiary" aria-hidden="true" />
              </motion.div>
            ))}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="flex items-center gap-1.5 text-[11px] text-success"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              已引用 2 个收藏视频
            </motion.div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
