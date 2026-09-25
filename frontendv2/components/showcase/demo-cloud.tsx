"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { Check, FileAudio, FileText, HardDriveUpload } from "lucide-react";

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

const FILES = [
  { name: "深度学习讲义.pdf", meta: "PDF · 2.4 MB" },
  { name: "读书笔记.md", meta: "Markdown · 18 KB" },
  { name: "讲座录音.m4a", meta: "音频 · 46:12" },
] as const;

// Per-file row timing (s): row i appears at i*ROW, progress fills, then check
const ROW = 1.15;

/**
 * Looping mockup: documents dropped into the cloud drive are parsed
 * (progress bar per file) and become searchable knowledge. Crossfades
 * between loop cycles; pauses while off-screen; static done-state under
 * reduced motion.
 */
export function DemoCloud() {
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
          className="rounded-2xl border border-border bg-surface p-4 shadow-[0_20px_60px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_24px_70px_rgba(0,0,0,0.11)] md:p-5"
        >
          <div className="flex items-center gap-1.5 border-b border-border-subtle pb-3">
            <HardDriveUpload className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span className="text-[12px] font-medium text-foreground">云盘 · 知识库</span>
            <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
              {reduced ? "已入库 42 份" : "自动解析中"}
            </span>
          </div>

          <div className="flex flex-col gap-2.5 pt-4">
            {FILES.map((f, i) => (
              <motion.div
                key={f.name}
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: reduced ? 0 : i * ROW, ease: EASE_APPLE }}
                className="rounded-xl border border-border-subtle bg-background px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  {f.name.endsWith(".m4a") ? (
                    <FileAudio className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{f.name}</span>
                    <span className="text-[10px] text-tertiary">{f.meta}</span>
                  </span>
                  <motion.span
                    initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.35, delay: reduced ? 0 : i * ROW + 1.05, ease: EASE_APPLE }}
                    className="flex items-center gap-1 text-[11px] text-success"
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                    已入库
                  </motion.span>
                </div>
                {/* Parse progress track; fills then hands over to the check */}
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-border-subtle">
                  <motion.div
                    className="h-full w-full origin-left rounded-full bg-accent"
                    initial={reduced ? false : { scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: reduced ? 0 : 0.9, delay: reduced ? 0 : i * ROW + 0.15, ease: "easeOut" }}
                  />
                </div>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: reduced ? 0 : FILES.length * ROW + 0.4 }}
            className="mt-4 border-t border-border-subtle pt-3 text-[11px] text-secondary"
          >
            3 份文档已完成解析，可与收藏视频一起检索
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
