"use client";

// Interactive artifact cards for the chat transcript.
//
// Dispatched by <ArtifactCard> for kind "plot" / "diagram" / "chart" /
// "comparison". Every renderer is a trusted React component fed a validated
// declarative spec — no HTML/JS from the model, no iframe. Diagrams
// additionally download as a .drawio file so users can open/edit them in
// draw.io without shipping the 4.9MB viewer; charts copy their raw numbers as
// CSV and comparisons copy as a Markdown table.

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { ChartView } from "./chart-view";
import { ComparisonView } from "./comparison-view";
import { DiagramView } from "./diagram-view";
import { InteractiveArtifactFrame, type InteractiveArtifactKind } from "./interactive-frame";
import { PlotView } from "./plot-view";
import { downloadDrawioFile } from "@/lib/artifacts/drawio-export";
import {
  isChartSpec,
  isComparisonSpec,
  isDiagramSpec,
  isPlotSpec,
  type ChartSpec,
  type ComparisonSpec,
} from "@/lib/artifacts/interactive-spec";

const PLOT_HEIGHT = 300;
const PLOT_EXPANDED_HEIGHT = 520;
const DIAGRAM_HEIGHT = 320;
const DIAGRAM_EXPANDED_HEIGHT = 520;
const CHART_HEIGHT = 320;
const CHART_EXPANDED_HEIGHT = 520;

export function InteractiveArtifact({ kind, data }: { kind: InteractiveArtifactKind; data: unknown }) {
  if (kind === "plot") {
    if (!isPlotSpec(data)) return null;
    const paramCount = data.params?.length ?? 0;
    return (
      <div className="sm:col-span-2">
        <InteractiveArtifactFrame
          kind="plot"
          title={data.title}
          subtitle={
            data.subtitle ??
            (paramCount > 0
              ? `${data.curves.length} 条曲线 · ${paramCount} 个参数滑块`
              : `${data.curves.length} 条曲线`)
          }
          spec={data}
          expandedChildren={<PlotView spec={data} height={PLOT_EXPANDED_HEIGHT} />}
        >
          <PlotView spec={data} height={PLOT_HEIGHT} />
        </InteractiveArtifactFrame>
      </div>
    );
  }

  if (kind === "diagram") {
    if (!isDiagramSpec(data)) return null;
    return (
      <div className="sm:col-span-2">
        <InteractiveArtifactFrame
          kind="diagram"
          title={data.title}
          subtitle={`${data.nodes.length} 个节点 · ${data.edges.length} 条连线`}
          spec={data}
          expandedChildren={<DiagramView spec={data} height={DIAGRAM_EXPANDED_HEIGHT} />}
          actions={
            <button
              type="button"
              onClick={() => downloadDrawioFile(data)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-label="下载 .drawio 文件"
              title="下载 .drawio，可在 draw.io 中打开编辑"
            >
              <Download className="h-3 w-3" aria-hidden="true" />
              .drawio
            </button>
          }
        >
          <DiagramView spec={data} height={DIAGRAM_HEIGHT} />
        </InteractiveArtifactFrame>
      </div>
    );
  }

  if (kind === "chart") {
    if (!isChartSpec(data)) return null;
    return <ChartArtifact data={data} />;
  }

  if (!isComparisonSpec(data)) return null;
  return <ComparisonArtifact data={data} />;
}

function ChartArtifact({ data }: { data: ChartSpec }) {
  return (
    <div className="sm:col-span-2">
      <InteractiveArtifactFrame
        kind="chart"
        title={data.title}
        subtitle={data.subtitle ?? `${data.categories.length} 类 · ${data.series.length} 组数据`}
        spec={data}
        expandedChildren={<ChartView spec={data} height={CHART_EXPANDED_HEIGHT} />}
        actions={<CopyAction text={chartToCsv(data)} label="复制数据" ariaLabel="复制数据为 CSV" />}
      >
        <ChartView spec={data} height={CHART_HEIGHT} />
      </InteractiveArtifactFrame>
    </div>
  );
}

function ComparisonArtifact({ data }: { data: ComparisonSpec }) {
  return (
    <div className="sm:col-span-2">
      <InteractiveArtifactFrame
        kind="comparison"
        title={data.title}
        subtitle={data.subtitle ?? `${data.items.length} 个方案`}
        spec={data}
        actions={<CopyAction text={comparisonToMarkdown(data)} label="复制表格" ariaLabel="复制为 Markdown 表格" />}
      >
        <ComparisonView spec={data} />
      </InteractiveArtifactFrame>
    </div>
  );
}

function CopyAction({ text, label, ariaLabel }: { text: string; label: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (insecure context / permission denied): stay quiet.
    }
  };
  return (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      {copied ? "已复制" : label}
    </button>
  );
}

function chartToCsv(spec: ChartSpec): string {
  const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = ["类别", ...spec.series.map((series) => (spec.unit ? `${series.name}（${spec.unit}）` : series.name))];
  const rows = spec.categories.map((category, index) => [
    category,
    ...spec.series.map((series) => String(series.values[index] ?? "")),
  ]);
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

function comparisonToMarkdown(spec: ComparisonSpec): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const attrLabels = Array.from(new Set(spec.items.flatMap((item) => (item.attrs ?? []).map((attr) => attr.label))));
  const header = ["方案", "概述", "优点", "缺点", ...attrLabels];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const item of spec.items) {
    const cells = [
      cell(item.name),
      cell(item.summary ?? ""),
      cell((item.pros ?? []).join("；")),
      cell((item.cons ?? []).join("；")),
      ...attrLabels.map((label) => cell(item.attrs?.find((attr) => attr.label === label)?.value ?? "")),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (spec.recommendation) lines.push("", `> 推荐：${cell(spec.recommendation)}`);
  return lines.join("\n");
}
