import { z } from "zod";
import { defineTool } from "../base.js";
import type { PlanRunner } from "../../agent/dag/runner.js";
import type { PlanGraph } from "../../agent/dag/types.js";
import { validatePlan } from "../../agent/dag/graph.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import { getRequestContext } from "../../context/request-context.js";

const log = createLogger("PLAN_TOOL");

const customAgentSchema = z.object({
  id: z.string().describe("小写 slug，节点通过它引用该 agent"),
  name: z.string().describe("展示名"),
  role: z.string().describe("角色一句话描述"),
  system_prompt: z.string().describe("为该 agent 编写的专属提示词/行为约束"),
  tools: z.array(z.string()).describe("可用工具子集"),
  max_steps: z.number().int().min(1).max(20).optional(),
  model: z.enum(["inherit", "gateway", "coding_plan"]).optional(),
});

const planNodeSchema = z.object({
  id: z.string().describe("小写 slug"),
  title: z.string(),
  agent: z.string().describe("CustomAgentSpec.id 或内置 agent 名"),
  deps: z.array(z.string()).describe("依赖节点 id；无依赖填空数组"),
  task: z.string().describe("交给该节点的完整任务"),
  acceptance: z.string().describe("可检查的验收标准"),
});

const graphSchema = z.object({
  goal: z.string(),
  agents: z.array(customAgentSchema).max(config.agent.plan.maxAgents),
  nodes: z.array(planNodeSchema).min(1).max(config.agent.plan.maxNodes),
});

/**
 * plan_and_run: main-agent-only planner tool. The model defines a DAG and
 * custom ReAct agents; PlanRunner executes it topologically. Validation errors
 * are returned as text so the model can repair the graph on the next step.
 */
export function createPlanAndRunTool(runner: PlanRunner, builtinAgents: string[], allowedTools: string[]) {
  return defineTool({
    name: "plan_and_run",
    description:
      "为复杂任务创建 DAG 计划并执行。你可以定义自定义 agent（role/system_prompt/tools），" +
      "节点通过 deps 形成有向无环图，系统按拓扑排序执行、同层并行、上游结果注入下游。" +
      "每个自定义 agent 内部是 ReAct。简单任务不要使用本工具。" +
      "\n可用工具：" + allowedTools.join(", ") +
      "\n复杂计划请同时设置 timeoutMs（例如 1800000），否则默认工具超时可能截断计划。",
    inputSchema: graphSchema,
    defaultTimeoutMs: 1_800_000,
    async execute(args, ctx, signal) {
      if (!config.agent.plan.enabled) {
        return "DAG 计划执行未启用，请直接使用现有工具/委托完成。";
      }
      const graph = { version: 1, ...args } as PlanGraph;
      const errors = validatePlan(graph, {
        builtinAgents,
        allowedTools,
        maxNodes: config.agent.plan.maxNodes,
        maxAgents: config.agent.plan.maxAgents,
      });
      if (errors.length > 0) {
        return "计划校验失败，请修正后重试：\n" + errors.map((e) => "- " + e.message).join("\n");
      }
      const result = await runner.run({
        graph,
        sessionId: ctx.chatSessionId ?? "anonymous",
        uid: ctx.uid,
        scope: ctx.scope,
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(signal ? { signal } : {}),
        onUpdate: (snapshot) => {
          ctx.collector.setPlan(snapshot);
          getRequestContext()?.emit?.({ type: "plan", plan: snapshot });
        },
      });
      if (result.error) return "计划执行失败：" + result.error;
      if (result.usage) ctx.collector.addDelegatedUsage(result.usage);
      if (result.sources.length > 0) ctx.collector.pushSources(result.sources);
      if (result.artifacts.length > 0) ctx.collector.pushArtifacts(result.artifacts);
      for (const interaction of result.interactions) ctx.collector.pushInteraction(interaction);
      const lines: string[] = [
        "【DAG 计划执行完成】ok=" + result.ok,
        "失败节点：" + (result.failed.length ? result.failed.join(", ") : "无"),
        "跳过节点：" + (result.skipped.length ? result.skipped.join(", ") : "无"),
        "",
        "节点结果：",
      ];
      for (const [id, output] of Object.entries(result.outputs)) {
        lines.push("### " + id + "\n" + output.slice(0, 4000));
      }
      log.info("[PLAN_TOOL] plan executed nodes=" + Object.keys(result.outputs).length + " failed=" + result.failed.length);
      return lines.join("\n");
    },
  });
}
