"use client";

/**
 * ThinkingPanel - unified "thinking process" panel for one assistant turn:
 * the model reasoning stream plus the tool-execution timeline behind a single
 * collapsible header.
 *
 * Pattern adapted from Vercel AI Elements (Reasoning/Tool), implemented with
 * this repo's shadcn/Radix <Collapsible> primitives
 * (frontendv2/components/ui/collapsible.tsx): a compact "thinking" trigger with
 * an icon, live/settled wording and a chevron, expanded into the reasoning body.
 * Radix supplies keyboard + aria behaviour, the visuals stay on the light Apple
 * tokens (no glassmorphism, no strong gradients).
 *
 * Behaviour preserved from the previous inline implementation in
 * chat-message.tsx:
 * - auto-expanded while the turn runs, collapsed once it settles;
 * - the first manual toggle takes over control for the rest of the message;
 * - the reasoning stream stays pinned to the bottom while it grows;
 * - live wording (with .chat-shimmer) and the settled summaries built from the
 *   step count + summed tool duration, keeping "已深度思考" / "执行过程 · N 步";
 * - reasoning renders through the shared <Markdown> renderer, very long
 *   reasoning starts collapsed (expand all / collapse), the reasoning can be
 *   copied, and the streaming tail keeps its caret.
 *
 * Tool steps render as <ToolStepCard> collapsible cards.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Copy, Sparkles } from "lucide-react";
import { Markdown } from "@/components/markdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ReasoningStep } from "./types";
import { ToolStepCard } from "./tool-step-card";

/** Reasoning longer than this starts collapsed (expand-all button). */
const LONG_REASONING_CHARS = 1200;

/** Compact "total thinking time": 0.4s / 2.3s / 12s. */
function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

interface ThinkingPanelProps {
  reasoning?: string;
  steps: ReasoningStep[];
  /** turn status; pending keeps the panel expanded and the tail cursor visible */
  status: "pending" | "completed" | "failed";
  /** turn still thinking/executing AND the answer body has not started yet */
  active: boolean;
  /** wall-clock seconds of the turn, used as a fallback when the tool steps carry no durations */
  elapsedSeconds?: number;
}

export const ThinkingPanel = memo(function ThinkingPanel({
  reasoning,
  steps,
  status,
  active,
  elapsedSeconds = 0,
}: ThinkingPanelProps) {
  const hasThinking = !!reasoning || steps.length > 0;
  const streaming = status === "pending";

  // Auto open/close derives from progress (React's "adjust state during render"
  // pattern): expand when thinking arrives, collapse once the turn settles. The
  // first manual toggle (userOpen becoming non-null) takes over permanently.
  const [autoOpen, setAutoOpen] = useState(() => hasThinking && (status === "pending" || !!reasoning));
  const [autoInputs, setAutoInputs] = useState({ status, hasThinking });
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (autoInputs.status !== status || autoInputs.hasThinking !== hasThinking) {
    setAutoInputs({ status, hasThinking });
    if (userOpen === null) {
      // 运行中保持展开；轮次结束后，只要存在思考链也继续展开，让用户
      // 直接滚动阅读。纯工具执行轮次仍收起到摘要行，避免整页工具卡。
      // 用户手动点过开关后不再自动干预。
      setAutoOpen(hasThinking && (status === "pending" || !!reasoning));
    }
  }
  const thinkingOpen = userOpen ?? autoOpen;

  // Keep the reasoning stream pinned to the bottom while it grows, but stop
  // following as soon as the user scrolls up to read an earlier part.
  const reasoningScrollRef = useRef<HTMLDivElement>(null);
  const [followTail, setFollowTail] = useState(true);
  useEffect(() => {
    if (!thinkingOpen || status !== "pending" || !followTail) return;
    const el = reasoningScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, thinkingOpen, status, followTail]);

  const onReasoningScroll = () => {
    const el = reasoningScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowTail(atBottom);
  };

  const [copied, setCopied] = useState(false);
  const handleCopyReasoning = async () => {
    if (!reasoning) return;
    try {
      await navigator.clipboard.writeText(reasoning);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  const reasoningLong = !!reasoning && reasoning.length > LONG_REASONING_CHARS;

  // Settled summary: N 秒 = sum of every tool step duration.
  const totalDurationMs = useMemo(
    () =>
      steps.reduce(
        (sum, step) =>
          sum + (typeof step.durationMs === "number" && Number.isFinite(step.durationMs) ? step.durationMs : 0),
        0
      ),
    [steps]
  );
  const seconds = reasoning
    ? formatSeconds(elapsedSeconds * 1000) || formatSeconds(totalDurationMs)
    : formatSeconds(totalDurationMs);

  // Header label: GPT-style "Thought for 12s" disclosure, with tool steps secondary.
  const label = (() => {
    if (streaming) {
      const live = reasoning ? "思考中" : "执行中";
      const elapsed = elapsedSeconds > 0 ? formatSeconds(elapsedSeconds * 1000) : "";
      return [live, elapsed, steps.length > 0 ? `${steps.length} 步` : ""]
        .filter(Boolean)
        .join(" · ");
    }
    if (reasoning) {
      const thought = seconds ? `思考了 ${seconds}` : "已深度思考";
      return steps.length > 0 ? `${thought} · ${steps.length} 步` : thought;
    }
    return `已执行 · ${steps.length} 步`;
  })();

  // Reasoning-style icon: sparkles for the reasoning stream, brain when the
  // turn only ran tools.
  const HeaderIcon = reasoning ? Sparkles : Brain;

  if (!hasThinking) return null;

  return (
    <div className="mb-2.5">
      <Collapsible open={thinkingOpen} onOpenChange={(next) => setUserOpen(next)}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group -ml-1 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-secondary transition-colors hover:bg-border-subtle/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          >
            <span className="relative grid h-4 w-4 shrink-0 place-items-center">
              <HeaderIcon
                className={cn(
                  "h-3.5 w-3.5",
                  active ? "text-accent" : "text-tertiary"
                )}
                aria-hidden="true"
              />
              {active && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-1 w-1 animate-pulse rounded-full bg-accent"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className={cn("min-w-0 truncate", streaming && "chat-shimmer font-medium")}>
              {label}
            </span>
            <ChevronDown
              className={cn(
                "ml-0.5 h-3 w-3 shrink-0 text-tertiary transition-transform",
                thinkingOpen && "rotate-180"
              )}
              aria-hidden="true"
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div
            className="ml-[7px] mt-1 border-l border-border/80 pb-1 pl-3.5 sm:pl-4"
            role="region"
            aria-label="思考过程"
            aria-busy={active}
          >
            {reasoning && (
              <div className="group/reasoning">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11px] font-medium tracking-wide text-tertiary">
                    思考过程
                  </span>
                  <span className="ml-auto flex items-center gap-1 opacity-70 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover/reasoning:opacity-100">
                    <button
                      type="button"
                      onClick={handleCopyReasoning}
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                      aria-label={copied ? "已复制思考内容" : "复制思考内容"}
                    >
                      {copied ? (
                        <Check className="h-3 w-3 text-success" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      )}
                      {copied ? "已复制" : "复制"}
                    </button>
                  </span>
                </div>
                <div
                  ref={reasoningScrollRef}
                  onScroll={onReasoningScroll}
                  tabIndex={0}
                  className={cn(
                    "md-body pr-2 text-[13px] leading-7 text-secondary",
                    reasoningLong && "thinking-scroll max-h-64 overflow-y-auto sm:max-h-80"
                  )}
                  aria-label="深度思考内容"
                >
                  <Markdown>{reasoning}</Markdown>
                  {status === "pending" && (
                    <span
                      className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse rounded-full bg-accent align-text-bottom"
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>
            )}

            {steps.length > 0 && (
              <div className={cn(reasoning && "mt-4")}>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-tertiary">
                  <span className="h-px flex-1 bg-border-subtle" />
                  <span>执行过程 · {steps.length} 步</span>
                  <span className="h-px flex-1 bg-border-subtle" />
                </div>
                <div className="rounded-xl border border-border-subtle bg-[#fbfcfe] p-3">
                  <ol className="list-none">
                    {steps.map((step, i) => (
                      <ToolStepCard
                        key={`${step.step}-${i}`}
                        step={step}
                        isLast={i === steps.length - 1}
                        toneIndex={i}
                      />
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
