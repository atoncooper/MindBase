import { describe, expect, it } from "vitest";
import {
  buildChartArtifact,
  buildComparisonArtifact,
  buildDiagramArtifact,
  buildPlotArtifact,
  capArtifacts,
  chartArgsSchema,
  comparisonArgsSchema,
  diagramArgsSchema,
  MAX_ARTIFACTS_PER_TURN,
  plotArgsSchema,
  validateExpression,
} from "../src/artifacts/interactive.js";
import type { ChartArgs, ComparisonArgs } from "../src/artifacts/interactive.js";
import {
  createRenderChartTool,
  createRenderComparisonTool,
  createRenderDiagramTool,
  createRenderPlotTool,
} from "../src/tools/render/index.js";

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

const chartArgs: ChartArgs = {
  title: "各月检索次数",
  subtitle: "2026 年知识库问答",
  chartType: "bar",
  categories: ["1 月", "2 月", "3 月"],
  series: [
    { name: "向量检索", values: [120, 180, 150] },
    { name: "KG 检索", values: [40, 55, 70] },
  ],
  unit: "次",
  yLabel: "次数",
};

const comparisonArgs: ComparisonArgs = {
  title: "PostgreSQL vs MySQL",
  subtitle: "面向知识库元数据存储",
  items: [
    {
      name: "PostgreSQL",
      summary: "功能更全的对象关系数据库",
      pros: ["JSONB 与检索能力强", "扩展生态成熟"],
      cons: ["运维成本略高"],
      attrs: [{ label: "学习成本", value: "中" }],
    },
    {
      name: "MySQL",
      summary: "部署与运维最省心的选择",
      pros: ["生态与托管服务普及", "上手快"],
      cons: ["复杂查询能力偏弱"],
    },
  ],
  recommendation: "元数据关系较简单时选 MySQL；需要 JSONB 检索时选 PostgreSQL。",
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

describe("chart artifact specs", () => {
  it("builds a bar chart artifact with stable shape", () => {
    const result = buildChartArtifact(chartArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.kind).toBe("chart");
    const data = result.artifact.data as Record<string, unknown>;
    expect(data.version).toBe(1);
    expect(String(data.id)).toMatch(/^chart_[0-9a-f]{8}$/);
    expect(data.categories).toEqual(chartArgs.categories);
    expect(data.chartType).toBe("bar");
  });

  it("rejects pie charts with more than one series", () => {
    const result = buildChartArtifact({ ...chartArgs, chartType: "pie" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("饼图");
  });

  it("rejects values whose length does not match categories", () => {
    const result = buildChartArtifact({
      ...chartArgs,
      series: [{ name: "向量检索", values: [1, 2] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("等长");
  });

  it("rejects non-finite values", () => {
    const result = buildChartArtifact({
      ...chartArgs,
      series: [{ name: "坏数据", values: [1, Number.NaN, 3] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("非有限");
  });

  it("chart schema accepts the documented field set", () => {
    expect(chartArgsSchema.safeParse(chartArgs).success).toBe(true);
    expect(chartArgsSchema.safeParse({ ...chartArgs, chartType: "scatter" }).success).toBe(false);
    expect(chartArgsSchema.safeParse({ ...chartArgs, categories: [] }).success).toBe(false);
  });
});

describe("comparison artifact specs", () => {
  it("builds a comparison artifact with stable shape", () => {
    const result = buildComparisonArtifact(comparisonArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.kind).toBe("comparison");
    const data = result.artifact.data as Record<string, unknown>;
    expect(data.version).toBe(1);
    expect(String(data.id)).toMatch(/^comparison_[0-9a-f]{8}$/);
    expect((data.items as unknown[]).length).toBe(2);
  });

  it("rejects fewer than two items", () => {
    const result = buildComparisonArtifact({ ...comparisonArgs, items: comparisonArgs.items.slice(0, 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("至少需要 2 个");
  });

  it("rejects duplicate item names", () => {
    const first = comparisonArgs.items[0]!;
    const result = buildComparisonArtifact({
      ...comparisonArgs,
      items: [first, { ...comparisonArgs.items[1]!, name: first.name }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("不能重复");
  });

  it("comparison schema accepts the documented field set", () => {
    expect(comparisonArgsSchema.safeParse(comparisonArgs).success).toBe(true);
    expect(comparisonArgsSchema.safeParse({ ...comparisonArgs, items: comparisonArgs.items.slice(0, 1) }).success).toBe(false);
  });
});

describe("render chart / comparison tools", () => {
  it("render_chart returns text + chart artifact and reports invalid specs", async () => {
    const tool = createRenderChartTool();
    const ok = await tool.execute(chartArgs as never, {} as never);
    expect(typeof ok).not.toBe("string");
    if (typeof ok !== "string") {
      expect(ok.content).toContain("已生成柱状图");
      expect(ok.content).toContain("3 个类别");
      expect(ok.artifacts?.[0]?.kind).toBe("chart");
    }

    const bad = await tool.execute({ ...chartArgs, chartType: "pie" } as never, {} as never);
    expect(typeof bad).toBe("string");
    expect(String(bad)).toContain("无法渲染");
  });

  it("render_comparison returns a comparison artifact and reports invalid specs", async () => {
    const tool = createRenderComparisonTool();
    const out = await tool.execute(comparisonArgs as never, {} as never);
    expect(typeof out).not.toBe("string");
    if (typeof out !== "string") {
      expect(out.artifacts?.[0]?.kind).toBe("comparison");
      expect(out.content).toContain("2 个对比项");
    }

    const bad = await tool.execute({ ...comparisonArgs, items: comparisonArgs.items.slice(0, 1) } as never, {} as never);
    expect(typeof bad).toBe("string");
    expect(String(bad)).toContain("无法渲染");
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
