"use client";

// Artifact frame shared by the lab prototypes: header (kind badge + title +
// actions), interactive body, and a collapsible view of the raw spec the model
// emitted. In production this frame is what <ArtifactCard> dispatches to for
// the new interactive kinds.

import { useEffect, useState, type ReactNode } from "react";
import { Braces, Maximize2, Minimize2 } from "lucide-react";

export type InteractiveArtifactKind = "plot" | "diagram" | "chart" | "comparison";

const KIND_META: Record<InteractiveArtifactKind, { badge: string; label: string }> = {
  plot: { badge: "ƒ", label: "交互函数图像" },
  diagram: { badge: "◇", label: "交互流程图" },
  chart: { badge: "▥", label: "数据图表" },
  comparison: { badge: "⇄", label: "方案对比" },
};

export function InteractiveArtifactFrame({
  kind,
  title,
  subtitle,
  spec,
  children,
  expandedChildren,
  actions,
}: {
  kind: InteractiveArtifactKind;
  title: string;
  subtitle?: string;
  spec: unknown;
  children: ReactNode;
  expandedChildren?: ReactNode;
  /** extra header buttons (e.g. "下载 .drawio") rendered before the spec toggle */
  actions?: ReactNode;
}) {
  const [showSpec, setShowSpec] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const meta = KIND_META[kind];

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const body = (
    <>
      {expanded && expandedChildren ? expandedChildren : children}
      {showSpec && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border-subtle bg-[#f5f5f7] p-3 font-mono text-[11px] leading-relaxed text-secondary">
          {JSON.stringify(spec, null, 2)}
        </pre>
      )}
    </>
  );

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-medium text-accent">
            {meta.badge}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
            <span className="block truncate text-[11px] text-tertiary">
              {meta.label}
              {subtitle ? ` · ${subtitle}` : ""}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {actions}
            <button
              type="button"
              onClick={() => setShowSpec((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-pressed={showSpec}
            >
              <Braces className="h-3 w-3" aria-hidden="true" />
              {showSpec ? "隐藏数据" : "模型输出"}
            </button>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="grid h-6 w-6 place-items-center rounded-md text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-label={expanded ? "退出全屏" : "全屏查看"}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </span>
        </div>
        <div className="p-3">{expanded ? null : body}</div>
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
            <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-2.5">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-medium text-accent">
                {meta.badge}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="grid h-7 w-7 place-items-center rounded-md text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                aria-label="退出全屏"
              >
                <Minimize2 className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto p-4">{body}</div>
          </div>
        </div>
      )}
    </>
  );
}
