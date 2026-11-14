// Demo payloads for the lab page — what the model would emit as artifact.data.
import type { ChartSpec, ComparisonSpec, DiagramSpec, PlotSpec } from "@/lib/artifacts/interactive-spec";

export const DEMO_PLOT: PlotSpec = {
  title: "y = a·sin(b·x + c) + d",
  subtitle: "拖动滑块改变参数，滚轮缩放、拖拽平移",
  xMin: -6.5,
  xMax: 6.5,
  curves: [
    { expr: "a*sin(b*x + c) + d", label: "f(x)", color: "#0071e3" },
    { expr: "a*b*cos(b*x + c)", label: "f′(x)", color: "#ff9f0a" },
  ],
  params: [
    { name: "a", label: "振幅 a", min: -3, max: 3, step: 0.05, value: 1.4 },
    { name: "b", label: "频率 b", min: 0.2, max: 4, step: 0.02, value: 1 },
    { name: "c", label: "相位 c", min: -Math.PI, max: Math.PI, step: 0.01, value: 0 },
    { name: "d", label: "偏移 d", min: -2, max: 2, step: 0.05, value: 0 },
  ],
};

export const DEMO_DIAGRAM: DiagramSpec = {
  title: "MindBase 对话检索链路",
  nodes: [
    { id: "user", label: "用户提问", x: 0, y: 96, w: 118, h: 52, shape: "round" },
    { id: "router", label: "AgentHarness\n路由 + ReAct", x: 150, y: 90, w: 152, h: 64, shape: "round", tone: "accent" },
    { id: "plan", label: "plan 工具\n步骤规划", x: 150, y: 0, w: 140, h: 48 },
    { id: "search", label: "vector_search\nMilvus 召回", x: 336, y: 10, w: 140, h: 52, tone: "success" },
    { id: "rerank", label: "Rerank 精排", x: 336, y: 92, w: 128, h: 48, tone: "success" },
    { id: "tool", label: "工具层\n笔记 / 白板 / 代码", x: 336, y: 176, w: 140, h: 52 },
    { id: "llm", label: "LLM 生成\n流式输出", x: 496, y: 90, w: 132, h: 56, shape: "round", tone: "accent" },
    { id: "ui", label: "交互式产物\n图表 · 流程图", x: 652, y: 88, w: 148, h: 60, shape: "round", tone: "warning" },
  ],
  edges: [
    { from: "user", to: "router" },
    { from: "router", to: "plan", dashed: true },
    { from: "router", to: "search" },
    { from: "search", to: "rerank" },
    { from: "rerank", to: "llm" },
    { from: "router", to: "tool" },
    { from: "tool", to: "llm" },
    { from: "llm", to: "ui" },
  ],
};

export const DEMO_CHART: ChartSpec = {
  version: 1,
  id: "chart_7f3a91c2",
  title: "MindBase 近半年问答与检索调用量",
  subtitle: "2026 年 6-11 月；统计口径为网关侧成功调用次数",
  chartType: "bar",
  categories: ["6 月", "7 月", "8 月", "9 月", "10 月", "11 月"],
  series: [
    { name: "问答次数", values: [12400, 15100, 18600, 24300, 31800, 38500] },
    { name: "检索次数", values: [8200, 10400, 13900, 19200, 26700, 33100] },
  ],
  unit: "次",
  xLabel: "月份",
  yLabel: "调用次数",
};

export const DEMO_COMPARISON: ComparisonSpec = {
  version: 1,
  id: "comparison_3d8b6e14",
  title: "向量检索方案选型：Milvus vs pgvector vs Elasticsearch",
  subtitle: "按当前约 120 万条 chunk 的规模与团队运维能力评估",
  items: [
    {
      name: "Milvus",
      summary: "专用向量数据库，当前生产环境已在用",
      pros: ["十亿级向量检索性能稳定", "原生支持 IVF / HNSW 多索引", "已有现成的运维与备份流程"],
      cons: ["独立组件，部署与监控成本较高", "小众查询需自行封装"],
      attrs: [
        { label: "部署复杂度", value: "中" },
        { label: "召回延迟", value: "约 35ms" },
        { label: "运维成本", value: "中" },
      ],
    },
    {
      name: "pgvector",
      summary: "复用现有 MySQL 迁移到 PostgreSQL 的运维经验",
      pros: ["与业务表同库，事务一致性好", "接入成本最低", "备份恢复沿用数据库方案"],
      cons: ["千万级以上需精细调参", "混合检索能力弱于专用库"],
      attrs: [
        { label: "部署复杂度", value: "低" },
        { label: "召回延迟", value: "约 80ms" },
        { label: "运维成本", value: "低" },
      ],
    },
    {
      name: "Elasticsearch",
      summary: "全文检索强项，可叠加 kNN 做混合检索",
      pros: ["BM25 + kNN 混合排序成熟", "分词与高亮开箱即用", "团队已有 ES 使用经验"],
      cons: ["向量召回精度依赖 HNSW 参数", "集群资源占用较高"],
      attrs: [
        { label: "部署复杂度", value: "中高" },
        { label: "召回延迟", value: "约 60ms" },
        { label: "运维成本", value: "高" },
      ],
    },
  ],
  recommendation:
    "短期内继续使用 Milvus（迁移风险最低）；若后续需要强事务一致或降低运维面，可先在非核心检索试点 pgvector，再评估整体迁移。",
};
