"use client";

/**
 * ToolStepCard - one tool call in the assistant's execution timeline.
 *
 * Pattern adapted from Vercel AI Elements (Reasoning/Tool), implemented with
 * this repo's shadcn/Radix <Collapsible> primitives
 * (frontendv2/components/ui/collapsible.tsx): a collapsible tool card whose
 * trigger carries the tool icon (same Chinese label mapping as before), the tool
 * name, a live/settled status and a chevron; the content holds the step detail
 * (pretty args / result preview / retrieval query / verdict / reasoning /
 * source chips). The visuals stay on the light Apple tokens - no glassmorphism,
 * no strong gradients.
 *
 * Collapse contract (one Collapsible per step):
 * - a running step (status "start", or legacy frames with neither status nor
 *   duration) starts expanded so its args are visible live;
 * - settled steps start collapsed and auto-collapse when they finish;
 * - once the user toggles a card manually, that choice wins for the step.
 *
 * The component is memoized: during a stream the chat view flushes ~every 80ms,
 * and a step whose object reference did not change must not re-render.
 */

import { memo, useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  Bot,
  Brain,
  ChartLine,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  ExternalLink,
  FileSearch,
  FileText,
  Globe,
  GraduationCap,
  Link as LinkIcon,
  ListChecks,
  ListVideo,
  LoaderCircle,
  Map,
  MessageCircleQuestionMark,
  Network,
  NotebookPen,
  Puzzle,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ChatSource } from "@/lib/chat-stream";
import type { ReasoningStep } from "./types";

interface ToolMeta {
  label: string;
  icon: LucideIcon;
}

// Tool name -> Chinese label + icon. Names mirror the tool registry in app-ts
// (src/tools/**) plus the MCP tools bridged from app-content-mcp. Unknown tools
// fall back to a generic "工具调用" entry and still render their raw name.
const TOOL_META: Record<string, ToolMeta> = {
  vector_search: { label: "检索知识库", icon: Search },
  kg_search: { label: "知识图谱检索", icon: Network },
  cloud_semantic_search: { label: "云盘语义检索", icon: Cloud },
  cloud_doc_summary: { label: "云盘摘要", icon: FileText },
  cloud_similar_files: { label: "相似文件", icon: FileSearch },
  web_search: { label: "联网搜索", icon: Globe },
  fetch_webpage: { label: "抓取网页", icon: LinkIcon },
  run_code: { label: "运行代码", icon: SquareTerminal },
  run_skill_code: { label: "运行技能", icon: Puzzle },
  load_skill: { label: "加载技能", icon: BookOpenCheck },
  render_plot: { label: "函数图像", icon: ChartLine },
  render_diagram: { label: "流程图", icon: Workflow },
  plan_and_run: { label: "计划执行", icon: ListChecks },
  delegate_to_agent: { label: "委派子 agent", icon: Bot },
  ask_user: { label: "询问用户", icon: MessageCircleQuestionMark },
  save_memory: { label: "记忆", icon: Brain },
  list_videos: { label: "视频列表", icon: ListVideo },
  get_video_summaries: { label: "视频摘要", icon: FileText },
  sandbox_bash: { label: "运行命令", icon: Terminal },
  sandbox_pwsh: { label: "运行命令", icon: Terminal },
  sandbox_grep: { label: "搜索代码", icon: FileSearch },
  // MCP: board / note / quiz domains (app-content-mcp)
  list_boards: { label: "思维导图 / 白板", icon: Map },
  get_board: { label: "思维导图 / 白板", icon: Map },
  create_board: { label: "思维导图 / 白板", icon: Map },
  update_board: { label: "思维导图 / 白板", icon: Map },
  pin_board: { label: "思维导图 / 白板", icon: Map },
  delete_board: { label: "思维导图 / 白板", icon: Map },
  save_note: { label: "笔记", icon: NotebookPen },
  list_notes: { label: "笔记", icon: NotebookPen },
  get_note: { label: "笔记", icon: NotebookPen },
  update_note: { label: "笔记", icon: NotebookPen },
  save_quiz: { label: "测验", icon: GraduationCap },
  save_grading: { label: "测验", icon: GraduationCap },
  emit_quiz: { label: "测验", icon: GraduationCap },
  emit_grading: { label: "测验", icon: GraduationCap },
};

const FALLBACK_TOOL: ToolMeta = { label: "工具调用", icon: Wrench };

// Collapse thresholds: args are usually compact JSON (pretty-printed here);
// the result preview is capped server-side at 400 chars.
const ARGS_MAX_LINES = 6;
const ARGS_MAX_CHARS = 240;
const RESULT_MAX_LINES = 3;
const RESULT_MAX_CHARS = 160;

/** Pretty-print compact JSON args; non-JSON previews render verbatim. */
function prettyArgs(raw?: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    return pretty ?? trimmed;
  } catch {
    return trimmed;
  }
}

function isLongArgs(text: string): boolean {
  return text.length > ARGS_MAX_CHARS || text.split("\n").length > ARGS_MAX_LINES;
}

function isLongResult(text: string): boolean {
  return text.length > RESULT_MAX_CHARS || text.split("\n").length > RESULT_MAX_LINES;
}

/** "850ms" / "1.2s" / "1m05s" - compact enough for the step header. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

// ---- Source helpers ---------------------------------------------------------
// Shared with chat-message.tsx (the main "引用来源" list) so a cloud-drive
// reference and an external bilibili link behave identically in both places.

/** 云盘文件引用按站内深链处理（同标签页打开）；其余来源是站外链接。 */
export function isInternalSource(src: { uploadUuid?: string }): boolean {
  return !!src.uploadUuid;
}

export function sourceHref(src: { url?: string; bvid?: string; uploadUuid?: string }): string {
  // 文件引用优先：uploadUuid 存在时进入云盘详情，不生成 bilibili 外链
  if (src.uploadUuid) return `/cloud-drive/${src.uploadUuid}`;
  return src.url || (src.bvid ? `https://www.bilibili.com/video/${src.bvid}` : "#");
}

/** Extract a readable domain / label for a citation chip. */
export function domainOf(src: { url?: string; uploadUuid?: string }): string {
  if (isInternalSource(src)) return "我的云盘";
  if (!src.url) return "bilibili.com";
  try {
    const u = new URL(src.url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return src.url.slice(0, 40);
  }
}

/** De-duplicate a step's sources by identity (uploadUuid > url > bvid > title). */
function dedupeSources(sources: ChatSource[]): ChatSource[] {
  const seen = new Set<string>();
  const out: ChatSource[] = [];
  for (const src of sources) {
    if (!src) continue;
    const key = src.uploadUuid || src.url || src.bvid || src.title || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(src);
  }
  return out;
}

interface ToolStepCardProps {
  step: ReasoningStep;
  /** last row in the timeline: no bottom spacing after it */
  isLast?: boolean;
}

export const ToolStepCard = memo(function ToolStepCard({
  step,
  isLast = false,
}: ToolStepCardProps) {
  // "start" = tool still running; "done" (or a duration without a status, for
  // legacy frames) = settled. Missing status + missing duration is treated as a
  // still-running legacy frame so it starts expanded.
  const hasStatus = step.status === "start" || step.status === "done";
  const running = step.status === "start" || (!hasStatus && typeof step.durationMs !== "number");
  const settled = !running && (step.status === "done" || typeof step.durationMs === "number");

  // Default expansion: running card open, settled card closed. The first manual
  // toggle takes over for this step; a later status change then only affects the
  // auto value that is no longer consulted.
  const [autoOpen, setAutoOpen] = useState(running);
  const [wasRunning, setWasRunning] = useState(running);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (wasRunning !== running) {
    setWasRunning(running);
    if (userOpen === null) setAutoOpen(running);
  }
  const open = userOpen ?? autoOpen;

  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [copied, setCopied] = useState<"args" | "result" | null>(null);

  const known = step.action in TOOL_META;
  const meta = known ? TOOL_META[step.action] : FALLBACK_TOOL;
  const Icon = meta.icon;

  const argsText = useMemo(() => prettyArgs(step.args), [step.args]);
  const argsLong = !!argsText && isLongArgs(argsText);
  const resultText = useMemo(
    () => (typeof step.resultPreview === "string" ? step.resultPreview.trim() : ""),
    [step.resultPreview]
  );
  const resultLong = isLongResult(resultText);
  const sources = useMemo(
    () => dedupeSources(Array.isArray(step.sources) ? step.sources : []),
    [step.sources]
  );

  const duration = typeof step.durationMs === "number" ? formatDuration(step.durationMs) : "";

  const copy = async (key: "args" | "result", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  return (
    <li className={cn("min-w-0", !isLast && "mb-2")}>
      <Collapsible
        open={open}
        onOpenChange={(next) => setUserOpen(next)}
        className={cn(
          "overflow-hidden rounded-lg border bg-surface transition-colors",
          running ? "border-accent/30" : "border-border-subtle"
        )}
      >
        {/* Trigger: icon + step no. + Chinese label + live/settled status + chevron. */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            title={step.action}
            className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-border-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          >
            <span
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-md border",
                running
                  ? "border-accent/30 bg-accent-soft text-accent"
                  : settled
                    ? "border-success/25 bg-success/10 text-success"
                    : "border-border-subtle bg-border-subtle/40 text-secondary"
              )}
              aria-hidden="true"
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">
              {String(step.step).padStart(2, "0")}
            </span>
            <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">
              {meta.label}
            </span>
            {!known && step.action && (
              <code className="min-w-0 truncate rounded bg-border-subtle/60 px-1 py-px font-mono text-[11px] text-tertiary">
                {step.action}
              </code>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {running && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] text-accent"
                  role="status"
                  aria-label="工具执行中"
                >
                  <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  执行中
                </span>
              )}
              {settled && (
                <span className="inline-flex items-center gap-1 text-[11px] text-success">
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {duration || "完成"}
                </span>
              )}
              <ChevronDown
                className={cn(
                  "h-3 w-3 text-tertiary transition-transform",
                  open && "rotate-180"
                )}
                aria-hidden="true"
              />
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-2.5 border-t border-border-subtle px-2.5 py-2.5">
            {/* Args - pretty JSON, collapsed past ~6 lines / 240 chars. */}
            {argsText && (
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-tertiary">参数</span>
                  {argsLong && (
                    <button
                      type="button"
                      onClick={() => setArgsOpen((v) => !v)}
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                      aria-expanded={argsOpen}
                    >
                      {argsOpen ? "收起" : "展开"}
                      <ChevronDown
                        className={cn("h-2.5 w-2.5 transition-transform", argsOpen && "rotate-180")}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copy("args", argsText)}
                    className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    aria-label={copied === "args" ? "已复制参数" : "复制参数"}
                  >
                    {copied === "args" ? (
                      <Check className="h-2.5 w-2.5 text-success" aria-hidden="true" />
                    ) : (
                      <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                    )}
                    {copied === "args" ? "已复制" : "复制"}
                  </button>
                </div>
                <pre
                  className={cn(
                    "m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-border-subtle/30 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-secondary",
                    argsLong && !argsOpen && "max-h-[7rem] overflow-hidden"
                  )}
                >
                  {argsText}
                </pre>
              </div>
            )}

            {/* Result preview - text summary from the backend done frame. */}
            {resultText && (
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-tertiary">结果</span>
                  {resultLong && (
                    <button
                      type="button"
                      onClick={() => setResultOpen((v) => !v)}
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                      aria-expanded={resultOpen}
                    >
                      {resultOpen ? "收起" : "展开"}
                      <ChevronDown
                        className={cn(
                          "h-2.5 w-2.5 transition-transform",
                          resultOpen && "rotate-180"
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copy("result", resultText)}
                    className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    aria-label={copied === "result" ? "已复制结果" : "复制结果"}
                  >
                    {copied === "result" ? (
                      <Check className="h-2.5 w-2.5 text-success" aria-hidden="true" />
                    ) : (
                      <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                    )}
                    {copied === "result" ? "已复制" : "复制"}
                  </button>
                </div>
                <div
                  className={cn(
                    "whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-border-subtle/30 px-2.5 py-2 text-[12px] leading-relaxed text-secondary",
                    resultLong && !resultOpen && "line-clamp-3"
                  )}
                >
                  {resultText}
                </div>
              </div>
            )}

            {/* Retrieval metadata kept from the legacy step frame. */}
            {step.query && (
              <div className="flex items-start gap-1.5 text-[12px]">
                <span className="shrink-0 text-[11px] text-tertiary">检索</span>
                <code className="min-w-0 break-all rounded bg-border-subtle/60 px-1.5 py-0.5 text-foreground">
                  {step.query}
                </code>
              </div>
            )}
            {step.verdict && (
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className={step.verdict === "sufficient" ? "text-success" : "text-warning"}>
                  结论：{step.verdict}
                </span>
                {step.recall_score != null && (
                  <span className="text-tertiary">召回 {step.recall_score.toFixed(3)}</span>
                )}
              </div>
            )}
            {step.reasoning && (
              <p className="m-0 text-[12px] leading-relaxed text-secondary">{step.reasoning}</p>
            )}
            {sources.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {sources.slice(0, 4).map((src) => (
                  <a
                    key={sourceHref(src) + src.title}
                    href={sourceHref(src)}
                    target={isInternalSource(src) ? undefined : "_blank"}
                    rel={isInternalSource(src) ? undefined : "noopener noreferrer"}
                    className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:text-foreground"
                  >
                    {isInternalSource(src) ? (
                      <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
                    ) : (
                      <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                    )}
                    <span className="max-w-[180px] truncate">{src.title}</span>
                  </a>
                ))}
                {sources.length > 4 && (
                  <span className="self-center text-[11px] text-tertiary">
                    +{sources.length - 4}
                  </span>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
});
