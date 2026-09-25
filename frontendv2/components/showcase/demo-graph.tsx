"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { Waypoints } from "lucide-react";

const EASE_APPLE = [0.28, 0.11, 0.32, 1] as const;

// Mock knowledge graph (SVG coords, viewBox 0 0 400 220).
const NODES = [
  { x: 150, y: 110, label: "向量检索", kind: "center" },
  { x: 265, y: 52, label: "Embedding", kind: "node" },
  { x: 268, y: 168, label: "语义分块", kind: "node" },
  { x: 348, y: 110, label: "重排序", kind: "node" },
  { x: 62, y: 46, label: "RAG 问答", kind: "node" },
  { x: 58, y: 176, label: "知识盲区", kind: "blindspot" },
] as const;

// Undirected edges by node index
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [0, 4],
  [0, 5],
];

/**
 * Looping mockup: a knowledge graph assembles itself node by node, then a
 * "blind spot" node starts pulsing with a discovery badge. Crossfades
 * between cycles; pauses while off-screen; static done-state under reduced
 * motion.
 */
export function DemoGraph() {
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
            <Waypoints className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span className="text-[12px] font-medium text-foreground">知识图谱 · 检索专题</span>
          </div>

          <svg viewBox="0 0 400 220" className="h-auto w-full pt-2" role="img" aria-label="知识图谱组装动画">
            {EDGES.map(([a, b], i) => {
              const na = NODES[a];
              const nb = NODES[b];
              return (
                <motion.line
                  key={`edge-${i}`}
                  x1={na.x}
                  y1={na.y}
                  x2={nb.x}
                  y2={nb.y}
                  stroke="var(--color-border)"
                  strokeWidth={1.4}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, delay: 0.5 + i * 0.25, ease: EASE_APPLE }}
                />
              );
            })}

            {NODES.map((n, i) => {
              const isCenter = n.kind === "center";
              const isBlind = n.kind === "blindspot";
              const w = n.label.length > 4 ? 96 : 84;
              const delay = 0.3 + i * 0.28;
              return (
                <motion.g
                  key={n.label}
                  initial={reduced ? false : { opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.45, delay: reduced ? 0 : delay, ease: EASE_APPLE }}
                  style={{ transformOrigin: `${n.x}px ${n.y}px` }}
                >
                  {isBlind && (
                    <motion.circle
                      cx={n.x}
                      cy={n.y}
                      r={30}
                      fill="none"
                      stroke="var(--color-warning)"
                      strokeWidth={1.2}
                      animate={reduced ? { opacity: 0.5 } : { opacity: [0.15, 0.7, 0.15] }}
                      transition={{ duration: 1.8, delay: reduced ? 0 : 2.2, repeat: Infinity, ease: "easeInOut" }}
                    />
                  )}
                  <rect
                    x={n.x - w / 2}
                    y={n.y - 15}
                    width={w}
                    height={30}
                    rx={15}
                    className={isCenter ? "fill-accent" : "fill-surface"}
                    stroke={isBlind ? "var(--color-warning)" : isCenter ? "none" : "var(--color-border)"}
                    strokeWidth={isBlind ? 1.4 : 1.2}
                  />
                  <text
                    x={n.x}
                    y={n.y + 4}
                    textAnchor="middle"
                    className={
                      isCenter
                        ? "fill-surface text-[11px] font-medium"
                        : isBlind
                          ? "fill-warning text-[11px] font-medium"
                          : "fill-foreground text-[11px]"
                    }
                  >
                    {n.label}
                  </text>
                </motion.g>
              );
            })}
          </svg>

          <motion.div
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: reduced ? 0 : 2.6, ease: EASE_APPLE }}
            className="mt-2 flex items-center gap-1.5 border-t border-border-subtle pt-3 text-[11px] text-warning"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
            发现 2 个知识盲区 · 建议先补「重排序」
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
