/**
 * Typed access to the agent harness: health snapshot, registered tools and
 * long-lived agent tasks (spawn/inject/stop live in chat flows; the status
 * pane is read + steer).
 */

import { invoke } from "@tauri-apps/api/core";

/** Shape of the Rust `harness_health` command output. */
export interface HarnessHealth {
  runtime: {
    totals: { callCount: number; errorCount: number };
    registeredTools: string[];
  };
  routableAgents: string[];
  activeSessions: number;
  breakers: { agent: string; state: string; failures: number }[];
  schedulerSlots: number;
}

/** One registered tool + the agents that bind it (`harness_tools`). */
export interface HarnessTool {
  name: string;
  description: string;
  agents: string[];
}

/** One long-lived agent task (`agent_task_list` / `agent_task_get`). */
export interface AgentTaskView {
  taskId: string;
  agent: string;
  description: string;
  sessionId: string;
  status: string;
  result: string | null;
  error: string | null;
  toolCalls: number;
  stepsDone: number;
  plan: TaskPlan | null;
  elapsedSecs: number;
  maxSteps: number;
  deadlineSecs: number;
  maxToolCalls: number;
}

export interface PlanStepView {
  desc: string;
  status: string;
  note: string;
}

export interface TaskPlan {
  version: number;
  steps: PlanStepView[];
  done: number;
  total: number;
}

export async function getHarnessHealth(): Promise<HarnessHealth> {
  return invoke<HarnessHealth>("harness_health");
}

export async function getHarnessTools(): Promise<HarnessTool[]> {
  const payload = await invoke<{ tools: HarnessTool[] }>("harness_tools");
  return payload.tools;
}

export async function listAgentTasks(): Promise<AgentTaskView[]> {
  return invoke<AgentTaskView[]>("agent_task_list");
}

export function injectAgentTask(taskId: string, message: string): Promise<void> {
  return invoke("agent_task_inject", { taskId, message });
}

export function stopAgentTask(taskId: string): Promise<void> {
  return invoke("agent_task_stop", { taskId });
}

/** Spawn a background agent task; resolves to the task id once queued. */
export function spawnAgentTask(args: {
  agent: string;
  task: string;
  sessionId: string;
  maxSteps?: number;
  deadlineSecs?: number;
  maxToolCalls?: number;
}): Promise<string> {
  return invoke<string>("agent_task_spawn", args);
}

/** Agent 展示名（与 Rust `AgentKind::name()` 对齐）。 */
export const AGENT_LABELS: Record<string, string> = {
  chat: "chat 主力",
  memory: "memory 记忆",
  note: "note 笔记",
  code: "code 代码",
  search: "search 搜索",
  academic: "academic 学术",
};

export function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name;
}
