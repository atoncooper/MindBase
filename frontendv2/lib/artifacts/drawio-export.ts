// Export an interactive diagram artifact as a real .drawio file.
//
// We do not bundle the 4.9MB drawio viewer: instead the artifact stays a light
// SVG in chat, and users who need the full editor download the diagram as
// mxGraphModel XML, which draw.io / diagrams.net open natively.

import type { DiagramSpec } from "./interactive-spec";

const TONE_COLORS: Record<string, { fill: string; stroke: string; font: string }> = {
  default: { fill: "#ffffff", stroke: "#d2d2d7", font: "#1d1d1f" },
  accent: { fill: "#eef4fd", stroke: "#0071e3", font: "#0b4f9e" },
  success: { fill: "#edfaf1", stroke: "#34c759", font: "#1d7a3a" },
  warning: { fill: "#fff7e8", stroke: "#ff9f0a", font: "#8a5a00" },
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shapeStyle(shape: string | undefined, tone: string | undefined): string {
  const color = TONE_COLORS[tone ?? "default"] ?? TONE_COLORS.default;
  const base = `fillColor=${color.fill};strokeColor=${color.stroke};fontColor=${color.font};strokeWidth=1.5;html=0;whiteSpace=wrap;`;
  switch (shape) {
    case "ellipse":
      return `ellipse;${base}`;
    case "diamond":
      return `rhombus;${base}`;
    case "rect":
      return `rounded=0;${base}`;
    case "round":
    default:
      return `rounded=1;arcSize=24;${base}`;
  }
}

/** Serialize a diagram spec to draw.io's native mxGraphModel XML. */
export function diagramToDrawioXml(spec: DiagramSpec): string {
  const cells: string[] = [
    '    <mxCell id="0" />',
    '    <mxCell id="1" parent="0" />',
  ];
  for (const node of spec.nodes) {
    const w = node.w ?? 156;
    const h = node.h ?? 56;
    cells.push(
      `    <mxCell id="${esc(node.id)}" value="${esc(node.label)}" style="${shapeStyle(node.shape, node.tone)}" vertex="1" parent="1">` +
        `<mxGeometry x="${node.x}" y="${node.y}" width="${w}" height="${h}" as="geometry" /></mxCell>`,
    );
  }
  spec.edges.forEach((edge, index) => {
    cells.push(
      `    <mxCell id="edge_${index + 1}" value="${esc(edge.label ?? "")}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;${
        edge.dashed ? "dashed=1;" : ""
      }" edge="1" parent="1" source="${esc(edge.from)}" target="${esc(edge.to)}">` +
        '<mxGeometry relative="1" as="geometry" /></mxCell>',
    );
  });
  return [
    '<mxfile host="MindBase">',
    `  <diagram name="${esc(spec.title)}" id="mindbase-diagram">`,
    '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    '      <root>',
    ...cells,
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
  ].join("\n");
}

/** Browser-only: trigger a .drawio download. */
export function downloadDrawioFile(spec: DiagramSpec): void {
  const xml = diagramToDrawioXml(spec);
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(spec.title || "diagram").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60)}.drawio`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
