"use client";

import { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { Markdown } from "@/components/markdown";
import {
  ExternalLink,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  AlertCircle,
  Sparkles,
  Pencil,
  ArrowRight,
} from "lucide-react";
import { isTypedArtifact, type ChatArtifact, type ChatInteraction, type ChatPlan, type ChatSource } from "@/lib/chat-stream";
import type { ReasoningStep } from "./types";
import { InteractionCard } from "./interaction-card";
import { PlanPanel } from "./plan-panel";
import { ThinkingPanel } from "./thinking-panel";
import { domainOf, isInternalSource, sourceHref } from "./tool-step-card";
import { InteractiveArtifact } from "./artifacts/interactive-artifact";
import { FileArtifactCard } from "./artifacts/file-artifact-card";
import { isChartSpec, isComparisonSpec, isDiagramSpec, isPlotSpec } from "@/lib/artifacts/interactive-spec";
import { isFileArtifactData, legacyFileArtifactData } from "@/lib/artifacts/file-spec";
import { useElapsedSeconds } from "./streaming-elapsed";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[] | null;
  artifacts?: ChatArtifact[] | null;
  reasoningSteps?: ReasoningStep[] | null;
  reasoning?: string;
  // Turn waiting in the backend admission queue (`queue` SSE frame); shows a
  // queue-position line in the pending row until the slot is granted.
  queuePosition?: number;
  // Sub-agent delegation live status (`delegate` SSE frame): currently-running
  // sub-agent + active count; cleared when the delegation finishes.
  subAgent?: { agent: string; count: number };
  // Structured AI→user interaction (ask_user → `interact` SSE frame): rendered
  // as a confirm card / option chips / form right under the answer text.
  interaction?: ChatInteraction | null;
  interactionAnswered?: boolean;
  onInteractionAnswer?: (answer: string) => void;
  // Live task plan (plan tool → `plan` SSE frame): compact checklist rendered
  // above the answer body. Frontend memory only; a history reload loses it.
  plan?: ChatPlan | null;
  // 多模态：用户消息附带的图片（data URL；仅本地实时态）
  images?: string[];
  /** 点击缩略图 → 打开大图预览(灯箱) */
  onImageOpen?: (src: string) => void;
  status?: "pending" | "completed" | "failed";
  error?: string;
  timestamp?: string;
  // Wall-clock start of this turn's stream (Date.now() recorded by chat-view at
  // send). Falls back to the ISO `timestamp` (message createdAt), then to the
  // moment the message mounts when the timestamp is unparseable.
  streamStartedAt?: number;
  onRegenerate?: () => void;
  // User-message editing (ChatGPT-style): onEdit opens the inline editor,
  // submit truncates the turn server-side and re-asks with the new content.
  onEdit?: () => void;
  isEditing?: boolean;
  onEditSubmit?: (content: string) => void;
  onEditCancel?: () => void;
}

// Progress of a plan snapshot. Mirrors PlanPanel's normalization so the running
// row never shows a done/total that disagrees with the panel above it.
function planProgress(plan: ChatPlan): { done: number; total: number } {
  const nodes = plan.nodes ?? [];
  const fallbackTotal = nodes.length > 0 ? nodes.length : plan.steps.length;
  const total = plan.total > 0 ? plan.total : fallbackTotal;
  return { done: Math.min(Math.max(plan.done, 0), total), total };
}

// Live running-row wording; highest-signal state first:
// queue > plan node > plan (no active node) > delegation > tool call > text.
function runningStatusLabel({
  queuePosition,
  plan,
  subAgent,
  lastStepAction,
  hasContent,
}: {
  queuePosition?: number;
  plan?: ChatPlan | null;
  subAgent?: { agent: string; count: number };
  lastStepAction?: string;
  hasContent: boolean;
}): string {
  if (queuePosition != null) return `排队中 · 第 ${queuePosition} 位…`;
  if (plan) {
    const nodes = plan.nodes ?? [];
    const { done, total } = planProgress(plan);
    const activeNode = nodes.find((node) => node.status === "in_progress");
    if (activeNode) return `正在执行计划：${activeNode.title}（${done}/${total}）`;
    // Legacy linear payload: the same frame may carry only `steps`.
    const activeStep = plan.steps.find((step) => step.status === "in_progress");
    if (activeStep) return `正在执行计划：${activeStep.desc}（${done}/${total}）`;
    if (nodes.length > 0 || plan.steps.length > 0) return `计划执行中（${done}/${total}）`;
  }
  if (subAgent) return `子任务执行中：${subAgent.agent}（${subAgent.count} 个）`;
  if (lastStepAction) return `正在调用工具：${lastStepAction}`;
  if (hasContent) return "生成中…";
  return "思考中…";
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

// ---- Artifacts (tool / sub-agent products) ----------------------------------
// Two shapes arrive over the stream (normalized in lib/chat-stream.ts):
//   * structured { kind, data } — quiz / quiz_grading today; summarized here
//   * file-style { name, url?, content_type? } — image / download
// Anything unrecognized degrades to a collapsed JSON block, never to raw HTML.

function numField(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function arrayLen(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const v = (data as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.length : undefined;
}

// Safe JSON preview for unknown artifact kinds; never throws on cycles.
function jsonPreview(data: unknown, max = 600): string {
  try {
    const text = JSON.stringify(data, null, 2) ?? String(data);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(data);
  }
}

// Summary card for a structured artifact: badge + title + optional detail line.
function StructuredArtifactCard({
  badge,
  title,
  detail,
}: {
  badge: string;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3 py-2">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
        {badge}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">{title}</span>
        {detail && <span className="block truncate text-[11px] text-tertiary">{detail}</span>}
      </span>
    </div>
  );
}

/** Internal structured payloads that ArtifactCard deliberately hides from the transcript. */
function isHiddenArtifact(artifact: ChatArtifact): boolean {
  return isTypedArtifact(artifact) && typeof artifact.kind === "string" && artifact.kind.startsWith("academic_");
}

function ArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  if (!isTypedArtifact(artifact)) {
    // Legacy file-style artifact (image / downloadable file). Map it onto the
    // new kind:"file" data contract so old history rows get the same card.
    const legacy = legacyFileArtifactData(
      artifact.name,
      artifact.url,
      artifact.content_type,
      artifact.size
    );
    return legacy ? <FileArtifactCard data={legacy} /> : null;
  }

  const { kind, data } = artifact;
  // Internal academic tool payloads are large structured blobs; the
  // user-facing file cards ride on their own kind:"file" artifact, so hide the
  // raw academic_* shape instead of adding JSON-fold noise to the transcript.
  if (kind.startsWith("academic_")) return null;
  if (kind === "file") {
    if (isFileArtifactData(data)) return <FileArtifactCard data={data} />;
    // Malformed payload: fall through to the file-ish / JSON fallbacks below.
  }
  if (kind === "quiz") {
    const count = arrayLen(data, "questions");
    const topic = strField(data, "topic");
    return (
      <StructuredArtifactCard
        badge="题"
        title={count != null ? `已生成 ${count} 道题` : "已生成题目"}
        detail={topic ?? (count == null ? jsonPreview(data, 80) : undefined)}
      />
    );
  }
  if (kind === "quiz_grading") {
    const score = numField(data, "score");
    const total = numField(data, "total");
    const detail =
      score != null && total != null
        ? `得分 ${score}/${total}`
        : jsonPreview(data, 80);
    return <StructuredArtifactCard badge="批" title="已批改" detail={detail} />;
  }
  // Interactive artifacts (plot / diagram / chart / comparison): declarative
  // specs rendered by trusted canvas/SVG/React components. Invalid payloads
  // fall through to the JSON fallback below instead of breaking the message.
  if (kind === "plot" && isPlotSpec(data)) {
    return <InteractiveArtifact kind="plot" data={data} />;
  }
  if (kind === "diagram" && isDiagramSpec(data)) {
    return <InteractiveArtifact kind="diagram" data={data} />;
  }
  if (kind === "chart" && isChartSpec(data)) {
    return <InteractiveArtifact kind="chart" data={data} />;
  }
  if (kind === "comparison" && isComparisonSpec(data)) {
    return <InteractiveArtifact kind="comparison" data={data} />;
  }
  // A structured artifact that also carries a file location (e.g. an exported
  // quiz PDF/image) → render it as a file card with a download link.
  if (artifact.url) {
    const legacy = legacyFileArtifactData(
      artifact.name ?? kind,
      artifact.url,
      artifact.content_type,
      artifact.size
    );
    if (legacy) return <FileArtifactCard data={legacy} />;
  }
  // Unknown structured kind → collapsed JSON detail (no raw HTML rendering).
  return (
    <details className="rounded-xl border border-border-subtle bg-surface px-3 py-2 sm:col-span-2">
      <summary className="cursor-pointer truncate text-[13px] text-foreground">产物 · {kind}</summary>
      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-secondary">
        {jsonPreview(data)}
      </pre>
    </details>
  );
}

function ChatMessage({
  role,
  content,
  sources,
  artifacts,
  reasoningSteps,
  reasoning,
  queuePosition,
  subAgent,
  interaction,
  interactionAnswered,
  onInteractionAnswer,
  plan,
  images,
  onImageOpen,
  status = "completed",
  error,
  timestamp,
  streamStartedAt,
  onRegenerate,
  onEdit,
  isEditing = false,
  onEditSubmit,
  onEditCancel,
}: ChatMessageProps) {
  // Normalize null/undefined -> [] so .length and .map are always safe.
  const safeSources = useMemo(() => (Array.isArray(sources) ? sources : []), [sources]);
  const safeArtifacts = useMemo(() => (Array.isArray(artifacts) ? artifacts : []), [artifacts]);
  // The artifact SSE frame may carry internal tool payloads (academic_* blobs)
  // that ArtifactCard intentionally renders as null. Header/count must follow
  // what is actually visible, otherwise an empty "生成产物" block is shown.
  const visibleArtifacts = useMemo(
    () => safeArtifacts.filter((artifact) => !isHiddenArtifact(artifact)),
    [safeArtifacts]
  );
  const safeReasoningSteps = useMemo(
    () => (Array.isArray(reasoningSteps) ? reasoningSteps : []),
    [reasoningSteps]
  );
  const lastStep = useMemo(
    () => safeReasoningSteps[safeReasoningSteps.length - 1],
    [safeReasoningSteps]
  );

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

  // Turn clock: prefer the wall-clock start handed down by the view, otherwise
  // parse the message createdAt; an unparseable timestamp counts from mount.
  const parsedTimestamp = timestamp ? Date.parse(timestamp) : NaN;
  const streamStartMs =
    streamStartedAt ?? (Number.isFinite(parsedTimestamp) ? parsedTimestamp : undefined);
  const elapsedSeconds = useElapsedSeconds(streamStartMs, isPending);
  const runningLabel = runningStatusLabel({
    queuePosition,
    plan,
    subAgent,
    lastStepAction: lastStep?.action,
    hasContent: !!content,
  });

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
        <div className="max-w-[78%]">
          {images && images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-2">
              {images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onImageOpen?.(src)}
                  className="overflow-hidden rounded-xl border border-border transition-transform hover:scale-[1.02]"
                  title="点击查看大图"
                >
                  <img
                    src={src}
                    alt={`附件 ${i + 1}`}
                    className="max-h-48 object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          {content && (
            <div className="whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-[#dce8fb] px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
              {content}
            </div>
          )}
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
        {/* Unified thinking panel: model reasoning stream + tool-execution
            timeline behind one collapsible pill (see thinking-panel.tsx). */}
        <ThinkingPanel
          reasoning={reasoning}
          steps={safeReasoningSteps}
          status={status}
          active={isPending && !content}
        />

        {/* Task plan (plan tool): live checklist above the answer body. DAG
            frames may carry nodes without legacy steps, so either shape renders. */}
        {plan && (plan.steps.length > 0 || (plan.nodes?.length ?? 0) > 0) && (
          <div className="mb-3">
            <PlanPanel plan={plan} />
          </div>
        )}

        {/* Content / loading / error */}
        <div className={isFailed ? "rounded-xl border border-danger/20 bg-danger/5 p-3" : ""}>
          {content && (
            // Markdown renders during streaming too - flushes are throttled
            // upstream (~80ms) so re-parsing stays cheap, and the switch from
            // streaming to the final render no longer jumps/reflows the text.
            <div className="md-body text-[15px] leading-relaxed text-foreground">
              <Markdown>{content}</Markdown>
              {/* Blinking caret at the tail of the streamed answer; removed as
                  soon as the turn settles (completed / failed). */}
              {isPending && (
                <span
                  className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse rounded-full bg-accent align-text-bottom"
                  aria-hidden="true"
                />
              )}
            </div>
          )}

          {/* Live running row. ALWAYS rendered while the turn is pending - even
              when text/reasoning is already on screen - so a long tool call,
              plan step or delegation never looks like a silently dead stream.
              Sits under the answer body, above interaction/sources. */}
          {isPending && (
            <div
              className={`${content ? "mt-1.5 " : ""}flex h-7 items-center gap-2.5 text-[12px] text-tertiary`}
              role="status"
              aria-label="助手正在执行"
            >
              <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "0ms" }} />
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "160ms" }} />
                <span className="chat-dot h-1.5 w-1.5 rounded-full bg-tertiary" style={{ animationDelay: "320ms" }} />
              </span>
              <span className="min-w-0 truncate">
                <span className="chat-shimmer font-medium">{runningLabel}</span>
                <span className="tabular-nums" aria-hidden="true">
                  {" · "}
                  {elapsedSeconds}s
                </span>
              </span>
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

        {/* Structured interaction (ask_user): confirm card / option chips / form */}
        {interaction && onInteractionAnswer && (
          <InteractionCard
            interaction={interaction}
            answered={!!interactionAnswered}
            onAnswer={onInteractionAnswer}
          />
        )}

        {/* Sources - citation cards */}
        {safeSources.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-secondary">引用来源</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {safeSources.slice(0, 6).map((source, i) => {
                const domain = domainOf(source);
                const internal = isInternalSource(source);
                return (
                  <a
                    key={i}
                    href={sourceHref(source)}
                    target={internal ? undefined : "_blank"}
                    rel={internal ? undefined : "noopener noreferrer"}
                    className="group/src flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3 py-2 transition-colors hover:border-border hover:bg-border-subtle/40"
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{source.title}</span>
                      <span className="text-[11px] text-tertiary">{domain}</span>
                    </span>
                    {internal ? (
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-tertiary transition-colors group-hover/src:text-secondary" aria-hidden="true" />
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-tertiary transition-colors group-hover/src:text-secondary" aria-hidden="true" />
                    )}
                  </a>
                );
              })}
              {safeSources.length > 6 && (
                <div className="text-[12px] text-tertiary">+{safeSources.length - 6} 个来源</div>
              )}
            </div>
          </div>
        )}

        {/* Artifacts - only render when at least one card is actually visible;
            internal academic_* payloads (hidden by ArtifactCard) must not leave an
            empty "生成产物" block behind. */}
        {visibleArtifacts.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-secondary">生成产物</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleArtifacts.map((art, i) => (
                <ArtifactCard key={i} artifact={art} />
              ))}
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
