"use client";

/**
 * PlanPanel - 任务计划面板（plan 工具 → `plan` SSE 帧）。
 *
 * 紧凑只读清单：头部「任务计划 vN · 完成 X/Y」+ 进度条，每条步骤 = 状态标记 +
 * 描述 + 可选 note。状态标记与桌面端一致：✓ done / ▶ in_progress / ✗ failed /
 * ⊘ skipped / · pending（未知状态降级为 ·，旧前端/旧后端混跑不崩）。
 *
 * 数据仅存于前端内存（挂在当前 assistant 消息上），不落库、刷新即丢——与
 * reasoning 流同性质；重试 reset 时由 chat-view 清空。
 */

import { cn } from "@/lib/utils";
import type { ChatPlan } from "@/lib/chat-stream";

const STEP_MARK: Record<string, string> = {
  pending: "·",
  in_progress: "▶",
  done: "✓",
  failed: "✗",
  skipped: "⊘",
};

const MARK_CLASS: Record<string, string> = {
  pending: "text-tertiary",
  in_progress: "text-accent",
  done: "text-success",
  failed: "text-danger",
  skipped: "text-tertiary",
};

const DESC_CLASS: Record<string, string> = {
  done: "text-secondary line-through",
  skipped: "text-tertiary line-through",
  failed: "text-danger",
};

export function PlanPanel({ plan }: { plan: ChatPlan }) {
  const total = plan.total > 0 ? plan.total : plan.steps.length;
  const done = Math.min(Math.max(plan.done, 0), total);
  const ratio = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className="rounded-xl border border-border-subtle bg-surface px-3.5 py-3"
      role="group"
      aria-label="任务计划"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-foreground">任务计划</span>
        <span className="text-[11px] text-tertiary">v{plan.version}</span>
        <span className="ml-auto text-[11px] text-tertiary">
          完成 {done}/{total}
        </span>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border-subtle" aria-hidden="true">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: ratio + "%" }}
        />
      </div>

      <ol className="mt-2.5 space-y-1.5">
        {plan.steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2 text-[13px] leading-relaxed">
            <span
              className={cn(
                "w-4 shrink-0 text-center text-[12px]",
                MARK_CLASS[step.status] ?? "text-tertiary"
              )}
              aria-hidden="true"
            >
              {STEP_MARK[step.status] ?? "·"}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("text-foreground", DESC_CLASS[step.status])}>
                {index + 1}. {step.desc}
              </span>
              {step.note && (
                <span className="ml-1.5 text-[12px] text-tertiary">— {step.note}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
