"use client";

import { useState, useEffect, useRef, useCallback, memo } from "react";
import { Markdown } from "@/components/markdown";
import {
  Brain,
  ChevronDown,
  ExternalLink,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  AlertCircle,
  Sparkles,
  Pencil,
} from "lucide-react";
import type { ChatArtifact, ChatSource } from "@/lib/chat-stream";
import type { ReasoningStep } from "./types";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  artifacts?: ChatArtifact[] | null;
  reasoningSteps?: ReasoningStep[] | null;
  reasoning?: string;
  agent?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
  timestamp?: string;
  onRegenerate?: () => void;
  // User-message editing (ChatGPT-style): onEdit opens the inline editor,
  // submit truncates the turn server-side and re-asks with the new content.
  onEdit?: () => void;
  isEditing?: boolean;
  onEditSubmit?: (content: string) => void;
  onEditCancel?: () => void;
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

// Inline editor for a user message. Mounted only while editing, so the draft
// state starts fresh from the original content every time. Enter submits,
// Shift+Enter newlines, Esc cancels.
function EditableUserMessage({
  content,
  onSubmit,
  onCancel,
}: {
  content: string;
  onSubmit: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    resize();
  }, [resize]);

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== content.trim()) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="w-[78%] rounded-[18px] rounded-br-md border border-accent/40 bg-surface px-4 py-2.5 focus-within:border-accent">
        <textarea
          ref={textareaRef}
          value={draft}
          autoFocus
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            resize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="block w-full resize-none bg-transparent text-[15px] leading-relaxed text-foreground outline-none"
          aria-label="编辑消息"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-border-subtle px-3 py-1 text-[12px] text-secondary transition-colors hover:text-foreground"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || draft.trim() === content.trim()}
          className="rounded-full bg-accent px-3.5 py-1 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          保存并发送
        </button>
      </div>
    </div>
  );
}

function ChatMessage({
  role,
  content,
  sources,
  artifacts,
  reasoningSteps,
  reasoning,
  agent,
  status = "completed",
  error,
  onRegenerate,
  onEdit,
  isEditing = false,
  onEditSubmit,
  onEditCancel,
}: ChatMessageProps) {
  // Normalize null/undefined -> [] so .length and .map are always safe.
  const safeSources = Array.isArray(sources) ? sources : [];
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const safeReasoningSteps = Array.isArray(reasoningSteps) ? reasoningSteps : [];
  const hasThinking = !!reasoning || safeReasoningSteps.length > 0;

  // Unified thinking panel (model reasoning stream + tool steps) - collapsed
  // by default; content only rendered while open ("load on open").
  //
  // While streaming the open state is derived from progress (React's
  // "adjust state during render" pattern): expand when thinking arrives,
  // collapse as soon as the answer starts. The first manual toggle (userOpen
  // becoming non-null) takes over control permanently for this message.
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoInputs, setAutoInputs] = useState({ content, status, hasThinking });
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (
    autoInputs.content !== content ||
    autoInputs.status !== status ||
    autoInputs.hasThinking !== hasThinking
  ) {
    setAutoInputs({ content, status, hasThinking });
    if (userOpen === null && status === "pending") {
      setAutoOpen(content ? false : hasThinking);
    }
  }
  const thinkingOpen = userOpen ?? autoOpen;
  const reasoningScrollRef = useRef<HTMLDivElement>(null);

  // Keep the reasoning stream pinned to the bottom while it grows.
  useEffect(() => {
    if (!thinkingOpen || status !== "pending") return;
    const el = reasoningScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, thinkingOpen, status]);

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

  // Panel header label: live wording while streaming, summary once settled.
  const thinkingActive = isPending && !content;
  const thinkingLabel = (() => {
    if (thinkingActive) {
      return reasoning ? "深度思考中…" : "执行中…";
    }
    if (reasoning) {
      return safeReasoningSteps.length > 0
        ? `已深度思考 · ${safeReasoningSteps.length} 步`
        : "已深度思考";
    }
    return `执行过程 · ${safeReasoningSteps.length} 步`;
  })();

  // ---- User message: right-aligned compact bubble (light blue, iMessage-ish) ----
  if (isUser) {
    if (isEditing && onEditSubmit && onEditCancel) {
      return (
        <div role="article" aria-roledescription="编辑用户消息">
          <EditableUserMessage content={content} onSubmit={onEditSubmit} onCancel={onEditCancel} />
        </div>
      );
    }
    return (
      <div className="group flex items-center justify-end gap-1.5" role="article" aria-roledescription="用户消息">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title="编辑并重新发送（此轮之后的对话将被移除）"
            aria-label="编辑消息"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-tertiary opacity-100 transition-colors hover:bg-border-subtle hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-[#dce8fb] px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
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
      {/* No vertical offset: the pending loading row below is h-7 too, so
          the "thinking" indicator sits exactly on the avatar's centerline. */}
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
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

        {/* Unified thinking panel - one toggle for the reasoning stream and
            the tool-execution timeline. */}
        {hasThinking && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setUserOpen((v) => !(v ?? autoOpen))}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-2.5 py-1 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-expanded={thinkingOpen}
              aria-controls="thinking-panel"
            >
              <Brain
                className={`h-3.5 w-3.5 ${thinkingActive ? "animate-pulse text-accent" : ""}`}
                aria-hidden="true"
              />
              <span>{thinkingLabel}</span>
              <ChevronDown
                className={`h-3 w-3 transition-transform ${thinkingOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>

            {thinkingOpen && (
              <div
                id="thinking-panel"
                className="mt-2 rounded-xl border border-border-subtle bg-border-subtle/40 px-3.5 py-3 text-[13px] text-secondary"
                role="region"
                aria-label="思考过程"
              >
                {/* Model reasoning stream - pinned to the bottom while growing */}
                {reasoning && (
                  <div
                    ref={reasoningScrollRef}
                    className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed"
                    aria-label="深度思考内容"
                  >
                    {reasoning}
                  </div>
                )}

                {/* Divider between the two sections when both are present */}
                {reasoning && safeReasoningSteps.length > 0 && (
                  <div className="my-3 flex items-center gap-2 text-[11px] text-tertiary">
                    <span className="h-px flex-1 bg-border" />
                    <span>执行步骤</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}

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
          </div>
        )}

        {/* Content / loading / error */}
        <div className={isFailed ? "rounded-xl border border-danger/20 bg-danger/5 p-3" : ""}>
          {isPending && !content && !reasoning ? (
            <div
              className="flex h-7 items-center gap-2.5 text-[13px] text-tertiary"
              role="status"
              aria-label="助手思考中"
            >
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "0ms" }} />
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "160ms" }} />
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "320ms" }} />
              </span>
              <span className="chat-shimmer font-medium">思考中…</span>
            </div>
          ) : (
            // Markdown renders during streaming too - flushes are throttled
            // upstream (~80ms) so re-parsing stays cheap, and the switch from
            // streaming to the final render no longer jumps/reflows the text.
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
                {onRegenerate && (
                  <button
                    type="button"
                    onClick={onRegenerate}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-danger/30 px-3 py-1 text-[12px] font-medium text-danger transition-colors hover:bg-danger/10"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    重试
                  </button>
                )}
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

        {/* Action bar - ghost icon buttons; hover-reveal on desktop, always
            visible on touch devices (no hover there). */}
        {showActions && (
          <div
            className="mt-2 flex items-center gap-0.5 opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            role="group"
            aria-label="消息操作"
          >
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
                title="重新生成本轮回复（此轮之后的对话将被移除）"
                className="grid h-7 w-7 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                aria-label="重新生成本轮回复"
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
