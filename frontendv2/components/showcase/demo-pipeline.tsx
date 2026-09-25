"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import {
  Check,
  Database,
  FileText,
  FolderSync,
  Loader2,
  Video,
} from "lucide-react";

const STAGES = [
  { icon: FolderSync, label: "同步收藏夹", desc: "接入 B站收藏" },
  { icon: FileText, label: "语音转写", desc: "ASR 提取全文" },
  { icon: Database, label: "语义分块", desc: "按含义切块" },
  { icon: Video, label: "向量入库", desc: "生成可检索索引" },
] as const;

const CHUNKS = ["费曼技巧 · 概念", "间隔重复 · 方法", "笔记系统 · 实践"];

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

/**
 * Looping pipeline mockup: a favorites video walks through sync → transcribe
 * → chunk → vectorize stages, producing knowledge chunks, fade out, restart.
 * Pauses while off-screen; static done-state under reduced motion.
 */
export function DemoPipeline() {
  const reduced = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(cardRef, { margin: "0px 0px -200px 0px" });
  // Stage currently active: 0..3, 4 = all done, 5 = fade out before restart.
  // Reduced motion derives the finished state at render time (no setState in
  // effect).
  const [stage, setStage] = useState(0);
  const shownStage = reduced ? 4 : stage;

  useEffect(() => {
    if (reduced || !inView) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    (async () => {
      while (!cancelled) {
        setStage(0);
        for (let s = 0; s < 4; s++) {
          await wait(950);
          if (cancelled) return;
        }
        setStage(4);
        await wait(3200);
        if (cancelled) return;
        setStage(5);
        await wait(500);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduced, inView]);

  const done = shownStage >= 4;
  const fading = shownStage === 5;

  return (
    <div
      ref={cardRef}
      className="rounded-2xl border border-border bg-surface p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_24px_70px_rgba(0,0,0,0.11)] md:p-5"
    >
      <div className="flex items-center justify-between border-b border-border-subtle pb-3">
        <span className="text-[12px] font-medium text-foreground">收藏夹 · 学习方法</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
          {done ? "已入库 128 条" : "同步中…"}
        </span>
      </div>

      <motion.div
        animate={{ opacity: fading ? 0 : 1 }}
        transition={{ duration: 0.4, ease: EASE_APPLE }}
        className="flex flex-col gap-2.5 pt-4"
      >
        {STAGES.map((s, i) => {
          const Icon = s.icon;
          const isDone = shownStage > i || done;
          const isActive = shownStage === i && !done;
          return (
            <div
              key={s.label}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-500 ${
                isActive
                  ? "border-accent/30 bg-accent-soft"
                  : "border-border-subtle bg-background"
              }`}
            >
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors duration-500 ${
                  isDone
                    ? "bg-success/10 text-success"
                    : isActive
                      ? "bg-accent text-accent-foreground"
                      : "bg-border-subtle text-tertiary"
                }`}
              >
                {isDone ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground">{s.label}</div>
                <div className="text-[11px] text-tertiary">{s.desc}</div>
              </div>
              {isActive && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" />}
            </div>
          );
        })}
        {/* Produced knowledge chunks */}
        <div className="mt-4 border-t border-border-subtle pt-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-tertiary">产出知识</div>
          <div className="flex flex-wrap gap-1.5">
            {CHUNKS.map((c, i) => (
              <motion.span
                key={c}
                initial={false}
                animate={done ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 8, scale: 0.95 }}
                transition={{ duration: 0.45, delay: done ? i * 0.15 : 0, ease: EASE_APPLE }}
                className="rounded-full border border-border-subtle bg-background px-2.5 py-1 text-[11px] text-secondary"
              >
                {c}
              </motion.span>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
