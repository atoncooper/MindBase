"use client";

// Interactive artifact cards for the chat transcript.
//
// Dispatched by <ArtifactCard> for kind "plot" / "diagram". Both renderers are
// trusted React components fed a validated declarative spec — no HTML/JS from
// the model, no iframe. Diagrams additionally download as a .drawio file so
// users can open/edit them in draw.io without shipping the 4.9MB viewer.

import { Download } from "lucide-react";
import { DiagramView } from "./diagram-view";
import { InteractiveArtifactFrame } from "./interactive-frame";
import { PlotView } from "./plot-view";
import { downloadDrawioFile } from "@/lib/artifacts/drawio-export";
import { isDiagramSpec, isPlotSpec } from "@/lib/artifacts/interactive-spec";

const PLOT_HEIGHT = 300;
const PLOT_EXPANDED_HEIGHT = 520;
const DIAGRAM_HEIGHT = 320;
const DIAGRAM_EXPANDED_HEIGHT = 520;

export function InteractiveArtifact({ kind, data }: { kind: "plot" | "diagram"; data: unknown }) {
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
