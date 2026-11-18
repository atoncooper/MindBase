/**
 * Plan DAG contracts for the planner/supervisor agent architecture.
 *
 * The main agent produces a PlanGraph once per complex turn. Nodes reference
 * either a built-in agent (note/code/quiz/board/academic) or a CustomAgentSpec
 * defined in the same graph, and declare dependencies used for topological
 * scheduling.
 */
import type { Artifact, InteractionPayload, PlanStepStatus, Source, TokenUsage } from "../../context/types.js";

export interface CustomAgentSpec {
  /** slug referenced by PlanNode.agent */
  id: string;
  /** display name shown in the plan panel */
  name: string;
  /** short role description (system prompt section) */
  role: string;
  /** planner-authored instructions for this agent */
  system_prompt: string;
  /** subset of the configured allowedCustomTools */
  tools: string[];
  /** ReAct step budget override */
  max_steps?: number;
  /** model routing hint; custom agents currently always use the gateway */
  model?: "inherit" | "gateway" | "coding_plan";
}

export interface PlanNode {
  id: string;
  title: string;
  /** CustomAgentSpec.id or a built-in agent name */
  agent: string;
  deps: string[];
  task: string;
  acceptance: string;
  /**
   * Human approval gate before this node executes (research).
   * When the gate reports "not approved" the runner pauses the whole run with
   * status "paused" instead of executing the node; /chat/plans/:runId/resume
   * continues after the user approves in the research workbench.
   */
  requiresApproval?: boolean;
}

export interface PlanGraph {
  version: 1;
  goal: string;
  agents: CustomAgentSpec[];
  nodes: PlanNode[];
}

export interface PlanRunNodeView {
  id: string;
  title: string;
  agent: string;
  deps: string[];
  status: PlanStepStatus;
  note?: string;
}

export interface PlanRunResult {
  runId?: string;
  ok: boolean;
  /** true when the run stopped at a requiresApproval node and awaits the user. */
  paused?: boolean;
  /** true when the run was cancelled by the user before finishing. */
  cancelled?: boolean;
  /** approval_id created/observed at the pause point (when available). */
  approvalId?: string;
  outputs: Record<string, string>;
  failed: string[];
  skipped: string[];
  error?: string;
  usage?: TokenUsage;
  sources: Source[];
  artifacts: Artifact[];
  interactions: InteractionPayload[];
}
