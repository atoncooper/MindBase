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
}

export const ThinkingPanel = memo(function ThinkingPanel({
  reasoning,
  steps,
  status,
  active,
}: ThinkingPanelProps) {
  const hasThinking = !!reasoning || steps.length > 0;
  const streaming = status === "pending";

  // Auto open/close derives from progress (React's "adjust state during render"
  // pattern): expand when thinking arrives, collapse once the turn settles. The
  // first manual toggle (userOpen becoming non-null) takes over permanently.
  const [autoOpen, setAutoOpen] = useState(() => status === "pending" && hasThinking);
  const [autoInputs, setAutoInputs] = useState({ status, hasThinking });
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (autoInputs.status !== status || autoInputs.hasThinking !== hasThinking) {
    setAutoInputs({ status, hasThinking });
    if (userOpen === null) {
      // 运行中的整轮保持展开：工具步骤/思考随产生即可见；轮次结束后收起到
      // 胶囊，用户仍可一键展开；用户手动点过开关后不再自动干预。
      setAutoOpen(status === "pending" ? hasThinking : false);
    }
  }
  const thinkingOpen = userOpen ?? autoOpen;

  // Keep the reasoning stream pinned to the bottom while it grows.
  const reasoningScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thinkingOpen || status !== "pending") return;
    const el = reasoningScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, thinkingOpen, status]);

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
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

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
  const seconds = formatSeconds(totalDurationMs);

  // Header label: shimmering live wording while streaming, summary once settled.
  const label = (() => {
    if (streaming) {
      const live = reasoning ? "正在思考" : "执行中";
      return steps.length > 0 ? `${live} · ${steps.length} 步` : live;
    }
    if (reasoning) {
      if (steps.length > 0) {
        return seconds
          ? `已深度思考 · 思考了 ${seconds} · ${steps.length} 步`
          : `已深度思考 · ${steps.length} 步`;
      }
      return seconds ? `已深度思考 · 思考了 ${seconds}` : "已深度思考";
    }
    return `已执行 · ${steps.length} 步`;
  })();

  // Reasoning-style icon: sparkles for the reasoning stream, brain when the
  // turn only ran tools.
  const HeaderIcon = reasoning ? Sparkles : Brain;

  if (!hasThinking) return null;

  return (
    <div className="mb-3">
      <Collapsible open={thinkingOpen} onOpenChange={(next) => setUserOpen(next)}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-left text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          >
            <HeaderIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                active ? "animate-pulse text-accent" : "text-tertiary"
              )}
              aria-hidden="true"
            />
            <span className={cn("min-w-0 truncate", streaming && "chat-shimmer font-medium")}>
              {label}
            </span>
            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 text-tertiary transition-transform",
                thinkingOpen && "rotate-180"
              )}
              aria-hidden="true"
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div
            className="mt-2 rounded-xl border border-border-subtle bg-border-subtle/40 px-3.5 py-3 text-[13px] text-secondary"
            role="region"
            aria-label="思考过程"
            aria-busy={active}
          >
            {/* Model reasoning stream - Markdown, pinned to the bottom while growing. */}
            {reasoning && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-medium text-tertiary">深度思考</span>
                  <span className="ml-auto flex items-center gap-1">
                    {reasoningLong && (
                      <button
                        type="button"
                        onClick={() => setReasoningExpanded((v) => !v)}
                        className="rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-surface hover:text-foreground"
                        aria-expanded={reasoningExpanded}
                      >
                        {reasoningExpanded ? "收起" : "展开全部"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleCopyReasoning}
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-surface hover:text-foreground"
                      aria-label={copied ? "已复制思考内容" : "复制思考内容"}
                    >
                      {copied ? (
                        <Check className="h-2.5 w-2.5 text-success" aria-hidden="true" />
                      ) : (
                        <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                      )}
                      {copied ? "已复制" : "复制"}
                    </button>
                  </span>
                </div>
                <div
                  ref={reasoningScrollRef}
                  className={cn(
                    "max-h-80 overflow-y-auto rounded-lg border border-border-subtle bg-surface px-3 py-2",
                    reasoningLong && !reasoningExpanded && "max-h-40 overflow-hidden"
                  )}
                  aria-label="深度思考内容"
                >
                  <div className="md-body text-[13px] leading-relaxed text-secondary">
                    <Markdown>{reasoning}</Markdown>
                  </div>
                  {/* Streaming tail indicator: the reasoning is still arriving. */}
                  {status === "pending" && (
                    <span
                      className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse rounded-full bg-accent align-text-bottom"
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>
            )}

            {/* Section heading keeps the previous "执行过程 · N 步" wording. */}
            {reasoning && steps.length > 0 && (
              <div className="my-3 flex items-center gap-2 text-[11px] text-tertiary">
                <span className="h-px flex-1 bg-border" />
                <span>执行过程 · {steps.length} 步</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {!reasoning && steps.length > 0 && (
              <div className="mb-1.5 text-[11px] text-tertiary">执行过程 · {steps.length} 步</div>
            )}

            {steps.length > 0 && (
              <ol className="list-none">
                {steps.map((step, i) => (
                  <ToolStepCard
                    key={`${step.step}-${i}`}
                    step={step}
                    isLast={i === steps.length - 1}
                  />
                ))}
              </ol>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
