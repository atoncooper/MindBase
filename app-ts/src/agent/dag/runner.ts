import type { SseFrame } from "../../transport/sse.js";
import type {
  Artifact,
  InteractionPayload,
  PlanNodeView,
  PlanSnapshot,
  SearchScope,
  Source,
  TokenUsage,
} from "../../context/types.js";
import type { AgentLifecycleManager } from "../lifecycle.js";
import type { AgentRuntime } from "../../tools/runtime.js";
import type { PromptRegistry } from "../prompts/loader.js";
import type { AgentInvokeInput } from "../types.js";
import { createCustomAgent, renderUpstream, type UpstreamResult } from "../custom/factory.js";
import { validatePlan, topoLayers } from "./graph.js";
import { ReflectService } from "./reflect.js";
import type { CustomAgentSpec, PlanGraph, PlanNode, PlanRunResult } from "./types.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";

const log = createLogger("PLAN");

export interface PlanRunnerDeps {
  lifecycle: AgentLifecycleManager;
  runtime: AgentRuntime;
  prompts: PromptRegistry;
  reflect?: ReflectService;
}

export interface PlanRunInput {
  graph: PlanGraph;
  sessionId: string;
  uid?: string;
  scope: SearchScope;
  /** resolved per-turn model (Coding Plan or caller-supplied) */
  model?: import("ai").LanguageModel;
  signal?: AbortSignal;
  /** invoked after every node status change; the caller persists/emits the snapshot */
  onUpdate?: (snapshot: PlanSnapshot) => void;
}

type NodeStatus = PlanNodeView["status"];

interface NodeState {
  status: NodeStatus;
  note?: string;
}

interface NodeRunResult {
  failed: boolean;
  output: string;
  note?: string;
  usage?: TokenUsage;
  sources: Source[];
  artifacts: Artifact[];
  interactions: InteractionPayload[];
}

function buildSnapshot(graph: PlanGraph, states: Map<string, NodeState>, version: number): PlanSnapshot {
  const nodes: PlanNodeView[] = graph.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    agent: node.agent,
    deps: node.deps,
    status: states.get(node.id)?.status ?? "pending",
    ...(states.get(node.id)?.note ? { note: states.get(node.id)!.note } : {}),
  }));
  const done = nodes.filter((n) => n.status === "done" || n.status === "skipped").length;
  const steps = nodes.map((n) => ({ desc: n.title, status: n.status, note: n.note ?? "" }));
  return { version, goal: graph.goal, nodes, steps, done, total: nodes.length };
}

function sumUsage(parts: TokenUsage[]): TokenUsage | undefined {
  if (parts.length === 0) return undefined;
  return parts.reduce(
    (acc, part) => ({
      inputTokens: (acc.inputTokens ?? 0) + (part.inputTokens ?? 0),
      outputTokens: (acc.outputTokens ?? 0) + (part.outputTokens ?? 0),
      totalTokens: (acc.totalTokens ?? 0) + (part.totalTokens ?? 0),
    }),
    {} as TokenUsage,
  );
}

/**
 * Dependency-driven DAG executor.
 *
 * A node becomes ready as soon as ALL its deps are done/skipped/failed; ready
 * nodes are fed to a bounded worker pool immediately (no layer barriers). A
 * failed node marks its dependants skipped while independent branches continue.
 *
 * Every node runs through lifecycle (built-in invokeReentrant / custom
 * invokeEphemeral), so cancellation, usage collection and breaker semantics stay
 * identical to normal delegation.
 */
export class PlanRunner {
  constructor(private readonly deps: PlanRunnerDeps) {}

  async run(input: PlanRunInput): Promise<PlanRunResult> {
    const planCfg = config.agent.plan;
    const graph = input.graph;
    const runtimeTools = new Set(this.deps.runtime.listToolDefs().map((tool) => tool.name));
    const allowedTools = planCfg.allowedTools.filter((name) => runtimeTools.has(name));
    const errors = validatePlan(graph, {
      builtinAgents: this.deps.lifecycle
        .registeredAgents()
        .map((a) => a.name)
        .filter((name) => name !== "main"),
      allowedTools,
      maxNodes: planCfg.maxNodes,
      maxAgents: planCfg.maxAgents,
    });
    if (errors.length > 0) {
      return {
        ok: false,
        outputs: {},
        failed: [],
        skipped: [],
        error: errors.map((e) => e.message).join("；"),
        sources: [],
        artifacts: [],
        interactions: [],
      };
    }
    const layers = topoLayers(graph);
    if (!layers) {
      return {
        ok: false,
        outputs: {},
        failed: [],
        skipped: [],
        error: "plan 存在环",
        sources: [],
        artifacts: [],
        interactions: [],
      };
    }

    const states = new Map<string, NodeState>();
    for (const node of graph.nodes) states.set(node.id, { status: "pending" });
    const outputs: Record<string, string> = {};
    const failed: string[] = [];
    const skipped: string[] = [];
    const usageParts: TokenUsage[] = [];
    const sources: Source[] = [];
    const artifacts: Artifact[] = [];
    const interactions: InteractionPayload[] = [];
    let version = 1;
    const publish = () => input.onUpdate?.(buildSnapshot(graph, states, version++));

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const specById = new Map(graph.agents.map((a) => [a.id, a]));
    const indegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const node of graph.nodes) {
      indegree.set(node.id, 0);
      children.set(node.id, []);
    }
    for (const node of graph.nodes) {
      for (const dep of node.deps ?? []) {
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
        children.get(dep)!.push(node.id);
      }
    }

    const ready = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    let running = 0;
    let completed = 0;
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const upstreamFor = (node: PlanNode): UpstreamResult[] =>
      (node.deps ?? [])
        .filter((id) => outputs[id] !== undefined)
        .map((id) => ({ id, title: nodeById.get(id)?.title ?? id, output: outputs[id]! }));

    const releaseChildren = (id: string) => {
      for (const child of children.get(id) ?? []) {
        const left = (indegree.get(child) ?? 1) - 1;
        indegree.set(child, left);
        if (left === 0) ready.push(child);
      }
    };

    const executeNode = async (id: string) => {
      const node = nodeById.get(id)!;
      const blocked = (node.deps ?? []).some((dep) => {
        const status = states.get(dep)?.status;
        return status === "failed" || status === "skipped";
      });
      if (blocked) {
        states.set(id, { status: "skipped", note: "上游节点失败或跳过" });
        skipped.push(id);
        publish();
        releaseChildren(id);
        return;
      }
      states.set(id, { status: "in_progress" });
      publish();
      try {
        const result = await this.runNode(node, specById.get(node.agent), input, upstreamFor(node));
        if (result.usage) usageParts.push(result.usage);
        sources.push(...result.sources);
        artifacts.push(...result.artifacts);
        interactions.push(...result.interactions);
        if (result.failed) {
          states.set(id, { status: "failed", note: result.output.slice(0, 300) });
          failed.push(id);
        } else {
          outputs[id] = result.output;
          states.set(id, { status: "done", note: result.note });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("[PLAN] node failed id=" + id + ": " + message);
        states.set(id, { status: "failed", note: message.slice(0, 300) });
        failed.push(id);
      } finally {
        publish();
        releaseChildren(id);
      }
    };

    const schedule = () => {
      while (running < planCfg.maxConcurrency && ready.length > 0) {
        const id = ready.shift()!;
        running += 1;
        void executeNode(id).finally(() => {
          running -= 1;
          completed += 1;
          if (completed >= graph.nodes.length) {
            resolveDone?.();
          } else {
            schedule();
          }
        });
      }
      if (completed + running === 0) resolveDone?.();
    };

    publish();
    schedule();
    await done;

    const usage = sumUsage(usageParts);
    const ok = failed.length === 0 && skipped.length === 0;
    return {
      ok,
      outputs,
      failed,
      skipped,
      ...(usage ? { usage } : {}),
      sources,
      artifacts,
      interactions,
    };
  }

  private async runNode(
    node: PlanNode,
    spec: CustomAgentSpec | undefined,
    run: PlanRunInput,
    upstream: UpstreamResult[],
  ): Promise<NodeRunResult> {
    const attempts = Math.max(0, config.agent.plan.reflectAttempts);
    let task = node.task;
    let last: NodeRunResult = {
      failed: true,
      output: "未执行",
      sources: [],
      artifacts: [],
      interactions: [],
    };

    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(config.agent.plan.nodeTimeoutMs);
      const nodeSignal = run.signal ? AbortSignal.any([run.signal, timeoutSignal]) : timeoutSignal;
      const agentInput: AgentInvokeInput = {
        query: spec ? task : renderTask(node, task, upstream),
        uid: run.uid,
        chatSessionId: run.sessionId,
        scope: {},
        history: [],
        ...(run.model ? { model: run.model } : {}),
        signal: nodeSignal,
      };
      let result: {
        content: string;
        failed: boolean;
        usage?: TokenUsage;
        sources: Source[];
        artifacts: Artifact[];
        interactions: InteractionPayload[];
      };
      if (spec) {
        const agent = createCustomAgent(spec, { ...node, task }, upstream, {
          runtime: this.deps.runtime,
          prompts: this.deps.prompts,
        });
        result = await this.deps.lifecycle.invokeEphemeral(() => agent, "custom-" + spec.id, agentInput);
      } else {
        result = await this.deps.lifecycle.invokeReentrant(node.agent, run.sessionId, agentInput);
      }

      last = {
        failed: result.failed,
        output: result.content,
        ...(result.usage ? { usage: result.usage } : {}),
        sources: result.sources,
        artifacts: result.artifacts,
        interactions: result.interactions,
      };
      if (result.failed) return last;
      if (!node.acceptance.trim() || attempts === 0 || !this.deps.reflect) {
        return { ...last, note: attempt > 0 ? "反思重试后完成" : undefined };
      }

      const review = await this.deps.reflect.review({
        goal: run.graph.goal,
        title: node.title,
        task: node.task,
        acceptance: node.acceptance,
        output: result.content,
        upstream: renderUpstream(upstream),
      });
      if (review.pass) {
        return { ...last, note: attempt > 0 ? "反思后通过" : undefined };
      }
      if (attempt >= attempts) {
        return { ...last, failed: true, note: "验收未通过：" + review.critique.slice(0, 200) };
      }
      task = node.task + "\n\n【反思修正】上次未通过验收：" + review.critique;
      log.info("[PLAN] node " + node.id + " failed acceptance, retrying (" + (attempt + 1) + "/" + attempts + ")");
    }
    return last;
  }
}

function renderTask(node: PlanNode, task: string, upstream: UpstreamResult[]): string {
  if (upstream.length === 0) return task;
  return task + "\n\n【上游依赖结果】\n" + renderUpstream(upstream);
}
