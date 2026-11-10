"use client";

/**
 * PlanPanel - 任务计划面板（plan 工具 → `plan` SSE 帧）。
 *
 * 支持两种数据形态，优先渲染 DAG：
 * - DAG（`plan.nodes`）：按 deps 拓扑分层（Kahn），同层横向节点卡片，层间用
 *   轻量箭头连接；桌面端卡片横向排布，移动端降级为按层分组的纵向列表。
 * - 旧线性（`plan.steps`）：保持原有紧凑只读清单。
 * 有环或依赖悬空（数据不完整）时自动降级为线性列表，绝不因坏数据崩溃。
 *
 * 数据仅存于前端内存（挂在当前 assistant 消息上），不落库、刷新即丢——与
 * reasoning 流同性质；重试 reset 时由 chat-view 清空。
 */

import { cn } from "@/lib/utils";
import type { ChatPlan, ChatPlanNode } from "@/lib/chat-stream";

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

const STATUS_LABEL: Record<string, string> = {
  pending: "待开始",
  in_progress: "进行中",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

// Node card tint per status: pending 灰 / in_progress 蓝 / done 绿 / failed 红 /
// skipped 灰（标题删除线）。只用主题 token，不引入新颜色。
const NODE_CARD_CLASS: Record<string, string> = {
  pending: "border-border-subtle bg-surface",
  in_progress: "border-accent/40 bg-accent-soft",
  done: "border-success/40 bg-surface",
  failed: "border-danger/40 bg-danger/5",
  skipped: "border-border-subtle bg-surface",
};

const NODE_TITLE_CLASS: Record<string, string> = {
  pending: "text-secondary",
  in_progress: "text-foreground",
  done: "text-secondary",
  failed: "text-danger",
  skipped: "text-tertiary line-through",
};

function AgentBadge({ agent, className }: { agent: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-border-subtle px-1.5 py-px text-[10px] font-medium text-secondary",
        className
      )}
    >
      {agent}
    </span>
  );
}

/**
 * Topologically layer the DAG (Kahn). Returns null when the graph cannot be laid
 * out - duplicate ids, deps on unknown nodes, self-deps or a cycle - so the
 * caller falls back to the flat list. Backend order is preserved inside a layer.
 */
function buildLayers(nodes: ChatPlanNode[]): ChatPlanNode[][] | null {
  const byId = new Map<string, ChatPlanNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) return null;
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      // Self-dependency or a dangling dep = incomplete payload.
      if (dep === node.id || !byId.has(dep)) return null;
    }
  }

  const layers: ChatPlanNode[][] = [];
  const placed = new Set<string>();
  while (placed.size < nodes.length) {
    const layer = nodes.filter(
      (node) => !placed.has(node.id) && node.deps.every((dep) => placed.has(dep))
    );
    // No node became ready => the remaining graph has a cycle.
    if (layer.length === 0) return null;
    for (const node of layer) placed.add(node.id);
    layers.push(layer);
  }
  return layers;
}

function NodeCard({ node }: { node: ChatPlanNode }) {
  const depsHint = node.deps.length > 0 ? `依赖：${node.deps.join(", ")}` : undefined;
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border px-2.5 py-2 text-[12px] leading-snug md:w-[200px]",
        NODE_CARD_CLASS[node.status] ?? NODE_CARD_CLASS.pending
      )}
      title={depsHint}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={cn("mt-px shrink-0 text-[11px]", MARK_CLASS[node.status] ?? "text-tertiary")}
          aria-hidden="true"
        >
          {STEP_MARK[node.status] ?? "·"}
        </span>
        <span
          className={cn(
            "min-w-0 break-words font-medium",
            NODE_TITLE_CLASS[node.status] ?? "text-secondary"
          )}
        >
          {node.title}
        </span>
        {/* status is colour-coded only; give assistive tech the actual state */}
        <span className="sr-only">{STATUS_LABEL[node.status] ?? node.status}</span>
      </div>
      {(node.agent || node.note) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[18px]">
          {node.agent && <AgentBadge agent={node.agent} />}
          {node.note && <span className="text-[11px] text-tertiary">{node.note}</span>}
        </div>
      )}
    </div>
  );
}

function LayerConnector() {
  return (
    <div
      className="hidden items-center justify-center gap-1 py-0.5 text-tertiary md:flex"
      aria-hidden="true"
    >
      <span className="h-2.5 w-px bg-border-subtle" />
      <span className="text-[11px] leading-none">↓</span>
    </div>
  );
}

function DagView({ layers }: { layers: ChatPlanNode[][] }) {
  return (
    <div className="mt-2.5 space-y-1">
      {layers.map((layer, layerIndex) => (
        <div key={layerIndex}>
          {layerIndex > 0 && <LayerConnector />}
          {/* Mobile: grouped vertical list. Desktop: horizontal cards per layer. */}
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-tertiary md:hidden">
            第 {layerIndex + 1} 层
          </p>
          <div className="flex flex-col gap-1.5 md:flex-row md:flex-wrap md:gap-2">
            {layer.map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface LinearItem {
  key: string;
  label: string;
  status: string;
  note?: string;
  agent?: string;
}

function LinearList({ items }: { items: LinearItem[] }) {
  return (
    <ol className="mt-2.5 space-y-1.5">
      {items.map((item, index) => (
        <li key={item.key} className="flex items-start gap-2 text-[13px] leading-relaxed">
          <span
            className={cn(
              "w-4 shrink-0 text-center text-[12px]",
              MARK_CLASS[item.status] ?? "text-tertiary"
            )}
            aria-hidden="true"
          >
            {STEP_MARK[item.status] ?? "·"}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("text-foreground", DESC_CLASS[item.status])}>
              {index + 1}. {item.label}
            </span>
            {item.agent && <AgentBadge agent={item.agent} className="ml-1.5 align-middle" />}
            {item.note && <span className="ml-1.5 text-[12px] text-tertiary">— {item.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PlanPanel({ plan }: { plan: ChatPlan }) {
  const nodes = plan.nodes ?? [];
  // DAG wins when the graph is well-formed; otherwise fall back to a flat list.
  const layers = nodes.length > 0 ? buildLayers(nodes) : null;
  const fallbackTotal = nodes.length > 0 ? nodes.length : plan.steps.length;
  const total = plan.total > 0 ? plan.total : fallbackTotal;
  const done = Math.min(Math.max(plan.done, 0), total);
  const ratio = total > 0 ? Math.round((done / total) * 100) : 0;
  const active = nodes.find((node) => node.status === "in_progress");

  const linearItems: LinearItem[] = layers
    ? []
    : nodes.length > 0
      ? nodes.map((node) => ({
          key: node.id,
          label: node.title,
          status: node.status,
          note: node.note,
          agent: node.agent,
        }))
      : plan.steps.map((step, index) => ({
          key: String(index),
          label: step.desc,
          status: step.status,
          note: step.note,
        }));

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

      {plan.goal && (
        <p className="mt-1 text-[12px] leading-relaxed text-secondary">{plan.goal}</p>
      )}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border-subtle" aria-hidden="true">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: ratio + "%" }}
        />
      </div>
      {nodes.length > 0 && (
        <p className="mt-1.5 text-[11px] text-tertiary" aria-live="polite">
          {active ? "正在执行：" + active.title : done >= total ? "计划执行完成" : "等待调度"}
        </p>
      )}

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border-subtle" aria-hidden="true">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: ratio + "%" }}
        />
      </div>

      {layers ? <DagView layers={layers} /> : <LinearList items={linearItems} />}
    </div>
  );
}
