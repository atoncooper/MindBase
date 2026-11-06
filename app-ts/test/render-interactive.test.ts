import { describe, expect, it } from "vitest";
import {
  buildDiagramArtifact,
  buildPlotArtifact,
  capArtifacts,
  diagramArgsSchema,
  MAX_ARTIFACTS_PER_TURN,
  plotArgsSchema,
  validateExpression,
} from "../src/artifacts/interactive.js";
import { createRenderDiagramTool, createRenderPlotTool } from "../src/tools/render/index.js";

const plotArgs = {
  title: "y = a·sin(bx + c) + d",
  xMin: -6.5,
  xMax: 6.5,
  curves: [
    { expr: "a*sin(b*x + c) + d", label: "f(x)" },
    { expr: "a*b*cos(b*x + c)", label: "f'(x)" },
  ],
  params: [
    { name: "a", label: "振幅", min: -3, max: 3, step: 0.05, value: 1.4 },
    { name: "b", min: 0.2, max: 4, step: 0.02, value: 1 },
    { name: "c", min: -3.15, max: 3.15, step: 0.01, value: 0 },
    { name: "d", min: -2, max: 2, step: 0.05, value: 0 },
  ],
};

const diagramArgs = {
  title: "检索链路",
  nodes: [
    { id: "user", label: "用户提问", x: 0, y: 96 },
    { id: "router", label: "AgentHarness", x: 150, y: 90, tone: "accent" as const },
    { id: "llm", label: "LLM 生成", x: 496, y: 90, shape: "round" as const },
  ],
  edges: [
    { from: "user", to: "router" },
    { from: "router", to: "llm", label: "检索完成" },
  ],
};

describe("interactive artifact specs", () => {
  it("builds a plot artifact with stable shape", () => {
    const result = buildPlotArtifact(plotArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.kind).toBe("plot");
    const data = result.artifact.data as Record<string, unknown>;
    expect(data.version).toBe(1);
    expect(String(data.id)).toMatch(/^plot_/);
    expect(Array.isArray(data.curves)).toBe(true);
  });

  it("rejects unknown identifiers and implicit functions outside the whitelist", () => {
    expect(validateExpression("a*sin(b*x)", ["a", "b"])).toBeNull();
    expect(validateExpression("2x + 3", [])).toBeNull();
    expect(validateExpression("evil(x)", [])).toContain("未知变量/函数");
    expect(validateExpression("a*sin(b*x)", ["b"])).toContain("未知变量/函数");
  });

  it("rejects inverted ranges and duplicate params", () => {
    expect(buildPlotArtifact({ ...plotArgs, xMax: -10 }).ok).toBe(false);
    expect(
      buildPlotArtifact({
        ...plotArgs,
        params: [
          { name: "a", min: 0, max: 1, step: 0.1, value: 0.5 },
          { name: "a", min: 0, max: 1, step: 0.1, value: 0.5 },
        ],
      }).ok,
    ).toBe(false);
  });

  it("zod schema enforces param value within range", () => {
    const parsed = plotArgsSchema.safeParse({
      ...plotArgs,
      params: [{ name: "a", min: 0, max: 1, step: 0.1, value: 5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("builds a diagram artifact and validates node references", () => {
    const result = buildDiagramArtifact(diagramArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.kind).toBe("diagram");
    expect(String((result.artifact.data as Record<string, unknown>).id)).toMatch(/^diagram_/);

    expect(
      buildDiagramArtifact({
        ...diagramArgs,
        edges: [{ from: "user", to: "missing" }],
      }).ok,
    ).toBe(false);
    expect(
      buildDiagramArtifact({
        ...diagramArgs,
        nodes: [...diagramArgs.nodes, diagramArgs.nodes[0]!],
      }).ok,
    ).toBe(false);
  });

  it("diagram schema accepts the documented field set", () => {
    expect(diagramArgsSchema.safeParse(diagramArgs).success).toBe(true);
  });

  it("caps persisted artifacts per turn", () => {
    const one = { kind: "plot", data: { blob: "x".repeat(1000) } };
    const many = Array.from({ length: MAX_ARTIFACTS_PER_TURN + 3 }, () => one);
    expect(capArtifacts(many)).toHaveLength(MAX_ARTIFACTS_PER_TURN);
    expect(capArtifacts([])).toHaveLength(0);
  });
});

describe("render tools", () => {
  it("render_plot returns text + artifact and reports invalid specs", async () => {
    const tool = createRenderPlotTool();
    const ok = await tool.execute(plotArgs as never, {} as never);
    expect(typeof ok).not.toBe("string");
    if (typeof ok !== "string") {
      expect(ok.content).toContain("已生成可交互函数图像");
      expect(ok.artifacts?.[0]?.kind).toBe("plot");
    }

    const bad = await tool.execute({ ...plotArgs, curves: [{ expr: "wat(x)" }] } as never, {} as never);
    expect(typeof bad).toBe("string");
    expect(String(bad)).toContain("无法渲染");
  });

  it("render_diagram returns a diagram artifact", async () => {
    const tool = createRenderDiagramTool();
    const out = await tool.execute(diagramArgs as never, {} as never);
    expect(typeof out).not.toBe("string");
    if (typeof out !== "string") {
      expect(out.artifacts?.[0]?.kind).toBe("diagram");
      expect(out.content).toContain("3 个节点");
    }
  });
});
