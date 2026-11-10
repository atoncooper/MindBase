# Agent DAG（Planner / Supervisor + 自定义 ReAct Agent）

> 2026-11 引入：主 agent 不再逐次手动 delegate，而是先产出有向无环图（DAG），
> 调度器按拓扑排序执行；节点可以是内置子 agent，也可以是 Planner 编写提示词的
> 自定义 ReAct agent。

## 1. 数据模型

```ts
PlanGraph {
  version: 1
  goal: string
  agents: CustomAgentSpec[]   // 最多 6
  nodes: PlanNode[]           // 最多 12
}

CustomAgentSpec {
  id: string                  // slug，节点引用
  name: string
  role: string
  system_prompt: string       // Planner 编写的专属提示词
  tools: string[]             // 只能是 allowedTools 子集
  max_steps?: number
  model?: "inherit" | "gateway" | "coding_plan"
}

PlanNode {
  id: string
  title: string
  agent: string               // CustomAgentSpec.id 或内置 agent
  deps: string[]              // 无环依赖
  task: string
  acceptance: string          // 反思验收标准
}
```

## 2. 执行流程

1. 主 agent 调用 `plan_and_run`（只有 main 持有该工具）；
2. `validatePlan` 校验：唯一 id、引用完整、无环、数量/工具/提示词上限；
3. 依赖驱动调度：入度归零的节点立即进入 ready 队列（不是按层 barrier），并发池默认 3；
4. 节点启动前把上游输出注入任务；
5. 内置 agent 走 `lifecycle.invokeReentrant`；自定义 agent 走
   `lifecycle.invokeEphemeral` + `createReactAgent`（内部仍是 ReAct）；
6. 节点完成后按 `acceptance` 调 ReflectService 复核；FAIL 时带 critique
   重跑一次；
7. 节点失败 → 依赖它的节点标记 skipped，独立分支继续；
8. 每个节点 pending → in_progress → done/failed/skipped 时实时发 `plan` SSE 帧，前端 PlanPanel 展示 DAG、当前执行节点、进度条与完成数。

## 3. 自定义 agent

`src/agent/custom/factory.ts` 用 `createReactAgent` 构建临时 agent：

- system prompt = `prompts/agents/custom.md` 渲染（角色 + Planner 提示词 +
  任务 + 验收标准 + 上游结果）；
- 工具 = `spec.tools` 与运行期已注册工具的交集；
- 不注册到全局 roster，不持有 `delegate_to_agent` / `plan` / `plan_and_run`
  （禁止递归派发）；
- 默认走平台网关；聊天框选中的 Coding Plan 模型通过通用 `model` 传给本轮所有
  agent（main / 内置子 agent / DAG 自定义 agent）。

## 4. 配置

`app-ts/config/default.yaml`：

```yaml
agent:
  plan:
    enabled: true
    maxAgents: 6
    maxNodes: 12
    maxConcurrency: 3
    customAgentMaxSteps: 6
    nodeTimeoutMs: 600000
    reflectAttempts: 1
    reflectTimeoutMs: 15000
    maxDepth: 1
    allowedTools: [...]
```

环境变量覆盖：`AGENT__PLAN__ENABLED` 等。

## 5. 失败与预算

- 节点级超时 `nodeTimeoutMs`，通过 AbortSignal 贯穿 ReAct；
- 节点失败/跳过不影响无依赖分支；
- 计划校验错误回给主 agent 修正一次；
- `plan_and_run` 工具调用建议显式设置 `timeoutMs=1800000`；
- 自定义 agent 不递归派发（maxDepth=1）。

## 6. 测试

- `app-ts/test/plan-graph.test.ts`：校验、环、拓扑层；
- `app-ts/test/plan-runner.test.ts`：依赖顺序、上游注入、失败跳过；
- 前端 `plan-panel`：DAG 分层渲染，数据不完整/有环时降级为线性列表。
