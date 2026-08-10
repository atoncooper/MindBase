"use client";

import { useState, useEffect, useRef, memo } from "react";
import { Markdown } from "@/components/markdown";
import {
  ChevronDown,
  ExternalLink,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import type { ChatArtifact, ChatSource } from "@/lib/chat-stream";

interface ReasoningStep {
  step: number;
  action: string;
  query?: string;
  reasoning?: string;
  verdict?: string;
  recall_score?: number;
  sources: ChatSource[];
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  artifacts?: ChatArtifact[] | null;
  reasoningSteps?: ReasoningStep[] | null;
  agent?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
  timestamp?: string;
  onRegenerate?: () => void;
}

// Extract a readable domain from a source URL for the citation card.
function domainOf(url?: string): string {
  if (!url) return "bilibili.com";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function sourceHref(src: { url?: string; bvid?: string }): string {
  return src.url || (src.bvid ? `https://www.bilibili.com/video/${src.bvid}` : "#");
}

function ChatMessage({
  role,
  content,
  sources,
  artifacts,
  reasoningSteps,
  agent,
  status = "completed",
  error,
  onRegenerate,
}: ChatMessageProps) {
  // Normalize null/undefined -> [] so .length and .map are always safe.
  const safeSources = Array.isArray(sources) ? sources : [];
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const safeReasoningSteps = Array.isArray(reasoningSteps) ? reasoningSteps : [];

  const [showReasoning, setShowReasoning] = useState(false);
  // Track manual toggle so auto-expand doesn't override the user's choice:
  // while streaming (pending) with steps arriving, auto-expand; once the
  // user toggles, respect their state.
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (!userToggledRef.current && safeReasoningSteps.length > 0 && status === "pending") {
      setShowReasoning(true);
    }
  }, [safeReasoningSteps.length, status]);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  const isUser = role === "user";
  const isPending = status === "pending";
  const isFailed = status === "failed";
  const showActions = !isUser && status === "completed" && !!content;

  // ---- User message: right-aligned compact bubble (light blue, iMessage-ish) ----
  if (isUser) {
    return (
      <div className="flex justify-end" role="article" aria-roledescription="用户消息">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-[18px] rounded-br-md bg-[#dce8fb] px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
          {content}
        </div>
      </div>
    );
  }

  // ---- Assistant message: avatar-led, full-width, no bubble ----
  return (
    <div
      className="group flex gap-3"
      role="article"
      aria-roledescription="助手消息"
      aria-live={isPending ? "polite" : "off"}
    >
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Sparkles className="h-3.5 w-3.5" />
      </div>

      <div className="min-w-0 flex-1">
        {/* Route badge - which agent handled this turn */}
        {agent && (
          <div className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[11px] text-secondary">
            <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
            <span>经由 {agent} agent</span>
          </div>
        )}

        {/* Reasoning toggle - chip, above content */}
        {safeReasoningSteps.length > 0 && (
          <button
            type="button"
            onClick={() => {
              userToggledRef.current = true;
              setShowReasoning((v) => !v);
            }}
            className="mb-2 inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
            aria-expanded={showReasoning}
            aria-controls="reasoning-content"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${showReasoning ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
            <span>{showReasoning ? "收起思考过程" : `展示思考过程 · ${safeReasoningSteps.length} 步`}</span>
          </button>
        )}

        {showReasoning && (
          <div
            id="reasoning-content"
            className="mb-3 rounded-xl border border-border-subtle bg-border-subtle/50 p-3 text-[13px] text-secondary"
            role="region"
            aria-label="思考过程详情"
          >
            {safeReasoningSteps.map((step, i) => {
              const stepSources = Array.isArray(step.sources) ? step.sources : [];
              return (
                <div key={i} className="border-l-2 border-border pl-3 [&:not(:first-child)]:mt-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-tertiary">
                      {String(step.step).padStart(2, "0")}
                    </span>
                    <span className="font-medium text-foreground">{step.action}</span>
                  </div>
                  {step.query && (
                    <div className="mt-1 flex gap-1.5">
                      <span className="text-[11px] text-tertiary">检索</span>
                      <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground">
                        {step.query}
                      </code>
                    </div>
                  )}
                  {step.reasoning && <div className="mt-1 leading-relaxed">{step.reasoning}</div>}
                  {step.verdict && (
                    <div className="mt-1.5 text-[12px]">
                      <span
                        className={
                          step.verdict === "sufficient" ? "text-success" : "text-warning"
                        }
                      >
                        结论：{step.verdict}
                      </span>
                      {step.recall_score != null && (
                        <span className="ml-2 text-tertiary">召回 {step.recall_score.toFixed(3)}</span>
                      )}
                    </div>
                  )}
                  {stepSources.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {stepSources.map((src, j) => (
                        <a
                          key={j}
                          href={sourceHref(src)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:text-foreground"
                        >
                          <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                          <span className="max-w-[180px] truncate">{src.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Content / loading / error */}
        <div className={isFailed ? "rounded-xl border border-danger/20 bg-danger/5 p-3" : ""}>
          {isPending && !content ? (
            <div className="flex items-center gap-1.5 py-1" role="status" aria-label="助手思考中">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:300ms]" />
            </div>
          ) : isPending ? (
            // Streaming: render plain text to avoid re-parsing markdown on every
            // token (the main cause of janky/non-incremental rendering).
            <div className="md-body whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
              {content}
            </div>
          ) : (
            <div className="md-body text-[15px] leading-relaxed text-foreground">
              <Markdown>{content || ""}</Markdown>
            </div>
          )}

          {isFailed && error && (
            <div className="mt-2 flex items-start gap-2 text-[13px] text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium">生成失败</div>
                <div className="text-danger/80">{error}</div>
              </div>
            </div>
          )}
        </div>

        {/* Sources - citation cards */}
        {safeSources.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-secondary">引用来源</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {safeSources.slice(0, 6).map((source, i) => {
                const domain = domainOf(source.url);
                return (
                  <a
                    key={i}
                    href={sourceHref(source)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group/src flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3 py-2 transition-colors hover:border-border hover:bg-border-subtle/40"
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{source.title}</span>
                      <span className="text-[11px] text-tertiary">{domain}</span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-tertiary transition-colors group-hover/src:text-secondary" aria-hidden="true" />
                  </a>
                );
              })}
              {safeSources.length > 6 && (
                <div className="text-[12px] text-tertiary">+{safeSources.length - 6} 个来源</div>
              )}
            </div>
          </div>
        )}

        {/* Artifacts - images/files produced by sub-agents */}
        {safeArtifacts.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-secondary">生成产物</div>
            <div className="flex flex-wrap gap-2">
              {safeArtifacts.map((art, i) => {
                const isImage = art.content_type?.startsWith("image/");
                return (
                  <div key={i} className="overflow-hidden rounded-xl border border-border-subtle">
                    {isImage && art.url ? (
                      <a href={art.url} target="_blank" rel="noopener noreferrer" title={art.name}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={art.url} alt={art.name} className="max-h-48 object-cover" loading="lazy" />
                      </a>
                    ) : (
                      <a
                        href={art.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] text-accent hover:underline"
                      >
                        <span className="truncate">{art.name}</span>
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Action bar - ghost icon buttons, reveal on row hover */}
        {showActions && (
          <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" role="group" aria-label="消息操作">
            <button
              type="button"
              onClick={handleCopy}
              className="grid h-7 w-7 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-label={copied ? "已复制" : "复制消息"}
              aria-live="polite"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={() => setFeedback(feedback === "up" ? null : "up")}
              className={`grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-border-subtle ${feedback === "up" ? "text-accent" : "text-tertiary hover:text-foreground"}`}
              aria-label="有帮助"
              aria-pressed={feedback === "up"}
            >
              <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setFeedback(feedback === "down" ? null : "down")}
              className={`grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-border-subtle ${feedback === "down" ? "text-accent" : "text-tertiary hover:text-foreground"}`}
              aria-label="无帮助"
              aria-pressed={feedback === "down"}
            >
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="grid h-7 w-7 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                aria-label="重新生成"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessage);
