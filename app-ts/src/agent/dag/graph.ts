import type { PlanGraph } from "./types.js";

/**
 * Structural validation for plan graphs. Returns a list of human-readable
 * errors the planner can fix on a retry; empty means the graph is runnable.
 */
export interface PlanValidationOptions {
  builtinAgents: string[];
  allowedTools: string[];
  maxNodes: number;
  maxAgents: number;
  maxPromptChars?: number;
}

export interface PlanValidationError {
  code: string;
  message: string;
}

const DEFAULT_MAX_PROMPT = 4000;

export function validatePlan(graph: PlanGraph, opts: PlanValidationOptions): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  const fail = (code: string, message: string) => errors.push({ code, message });
  const maxPrompt = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT;

  if (!graph || graph.version !== 1) fail("version", "plan.version 必须为 1");
  if (!graph.goal || !graph.goal.trim()) fail("goal", "plan.goal 不能为空");
  if (!Array.isArray(graph.agents)) fail("agents", "plan.agents 必须是数组");
  if (!Array.isArray(graph.nodes)) fail("nodes", "plan.nodes 必须是数组");
  if (errors.length > 0) return errors;

  if (graph.agents.length > opts.maxAgents) {
    fail("too_many_agents", "自定义 agent 数量 " + graph.agents.length + " 超过上限 " + opts.maxAgents);
  }
  if (graph.nodes.length === 0) fail("empty", "plan.nodes 不能为空");
  if (graph.nodes.length > opts.maxNodes) {
    fail("too_many_nodes", "节点数量 " + graph.nodes.length + " 超过上限 " + opts.maxNodes);
  }

  const allowedAgents = new Set<string>(opts.builtinAgents);
  const allowedTools = new Set(opts.allowedTools);
  const agentIds = new Set<string>();
  for (const agent of graph.agents) {
    if (!agent.id || !/^[a-z0-9_-]{1,32}$/.test(agent.id)) {
      fail("agent_id", "自定义 agent id 必须是 1-32 位小写字母/数字/_/-: " + String(agent.id));
      continue;
    }
    if (agentIds.has(agent.id)) fail("agent_duplicate", "自定义 agent id 重复: " + agent.id);
    agentIds.add(agent.id);
    if (!agent.name || !agent.name.trim()) fail("agent_name", "agent " + agent.id + " 缺少 name");
    if (!agent.role || !agent.role.trim()) fail("agent_role", "agent " + agent.id + " 缺少 role");
    if (!agent.system_prompt || !agent.system_prompt.trim()) {
      fail("agent_prompt", "agent " + agent.id + " 缺少 system_prompt");
    } else if (agent.system_prompt.length > maxPrompt) {
      fail("agent_prompt_too_long", "agent " + agent.id + " system_prompt 超过 " + maxPrompt + " 字符");
    }
    if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
      fail("agent_tools", "agent " + agent.id + " 至少需要 1 个工具");
    } else {
      for (const tool of agent.tools) {
        if (!allowedTools.has(tool)) fail("agent_tool", "agent " + agent.id + " 使用了不允许的工具: " + tool);
      }
    }
    if (agent.max_steps !== undefined && (!Number.isInteger(agent.max_steps) || agent.max_steps < 1 || agent.max_steps > 20)) {
      fail("agent_steps", "agent " + agent.id + " max_steps 必须是 1-20 的整数");
    }
  }
  for (const id of agentIds) allowedAgents.add(id);

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || !/^[a-z0-9_-]{1,32}$/.test(node.id)) {
      fail("node_id", "节点 id 必须是 1-32 位小写字母/数字/_/-: " + String(node.id));
      continue;
    }
    if (nodeIds.has(node.id)) fail("node_duplicate", "节点 id 重复: " + node.id);
    nodeIds.add(node.id);
    if (!node.title || !node.title.trim()) fail("node_title", "节点 " + node.id + " 缺少 title");
    if (!node.agent || !allowedAgents.has(node.agent)) {
      fail("node_agent", "节点 " + node.id + " 引用了未知 agent: " + String(node.agent));
    }
    if (!node.task || !node.task.trim()) fail("node_task", "节点 " + node.id + " 缺少 task");
    if (!Array.isArray(node.deps)) fail("node_deps", "节点 " + node.id + " deps 必须是数组");
  }
  for (const node of graph.nodes) {
    for (const dep of node.deps ?? []) {
      if (dep === node.id) fail("self_dep", "节点 " + node.id + " 不能依赖自己");
      else if (!nodeIds.has(dep)) fail("missing_dep", "节点 " + node.id + " 依赖不存在的节点: " + dep);
    }
  }
  if (errors.length === 0 && topoLayers(graph) === null) {
    fail("cycle", "plan 存在环，必须是有向无环图");
  }
  return errors;
}

/**
 * Kahn topological layers. Returns null on a cycle.
 * Nodes keep their original order inside each layer for deterministic tests.
 */
export function topoLayers(graph: PlanGraph): string[][] | null {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const node of graph.nodes) {
    for (const dep of node.deps ?? []) {
      if (!nodes.has(dep)) return null;
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      outgoing.get(dep)!.push(node.id);
    }
  }
  const layers: string[][] = [];
  let ready = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (ready.length > 0) {
    layers.push(ready);
    const next: string[] = [];
    for (const id of ready) {
      for (const child of outgoing.get(id) ?? []) {
        const left = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, left);
        if (left === 0) next.push(child);
      }
    }
    ready = next;
  }
  const total = [...indegree.values()].reduce((acc, n) => acc + n, 0);
  return total === 0 ? layers : null;
}
