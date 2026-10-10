import { jsonSchema, tool, type Tool } from "ai";
import { z, ZodObject, ZodType } from "zod";
import type { ToolRunContext } from "../context/types.js";
import type { ToolDefinition, ToolOutput } from "./base.js";
import { createLogger } from "../logger.js";
import { config } from "../config/index.js";
import { timeoutManager } from "./timeout-manager.js";
import { Semaphore } from "./concurrency.js";
import { CircuitBreaker } from "../agent/circuit.js";

/**
 * AgentRuntime: the unified execution layer after the LLM emits tool_calls.
 *
 * Every call passes through the same gate sequence (in order):
 *   1. tool-level breaker   — a tool with consecutive failures/timeouts is short-circuited
 *                             until its cooldown ends (no per-turn 60s timeout grinding)
 *   2. repeat-call ledger   — same tool + same args within one turn beyond the limit is
 *                             rejected (timeoutMs excluded from the key)
 *   3. concurrency slot     — global semaphore with a bounded wait; on exhaustion fail
 *                             fast ("系统繁忙") instead of deep-queuing
 *   4. TimeoutManager run   — unified budget: clamps, aborts, deletes on expiry
 *
 * Failures (throw or timeout) feed the tool breaker; a success resets it. Errors never
 * break the ReAct loop — they come back as text the model can reason about.
 */
const log = createLogger("TOOL");

export interface ToolMetrics {
  calls: number;
  errors: number;
  timeouts: number;
  /** calls that could not get a concurrency slot within the wait budget */
  busy: number;
  /** calls short-circuited by the tool breaker */
  shortCircuited: number;
  totalMs: number;
}

/** the model-controlled per-call budget, injected into every object-shaped tool schema */
const timeoutField = z
  .number()
  .int()
  .min(1000)
  .max(3_600_000)
  .optional()
  .describe(
    "本次调用的超时毫秒（1s–1h，超过 1h 会被强制钳到 1h）。非必要避免调高：" +
      "普通检索/读取/写入用默认即可；仅长任务（委托整理长笔记、沙箱跑复杂代码等）才放大，如 30000/60000/1800000",
  );

/** the same budget field as plain JSON Schema (for MCP-provided raw schemas) */
const jsonTimeoutField = {
  type: "integer",
  minimum: 1000,
  maximum: 3_600_000,
  description: timeoutField.description ?? "",
} as const;

/** Inject the shared timeoutMs argument into object-shaped schemas (zod or raw JSON Schema). */
function withTimeoutArg(schema: ToolDefinition["inputSchema"]): ToolDefinition["inputSchema"] {
  if (schema instanceof ZodObject) {
    return (schema as z.ZodObject<z.ZodRawShape>).extend({ timeoutMs: timeoutField });
  }
  if (schema instanceof ZodType) {
    return schema; // non-object zod schemas untouched
  }
  if (schema && typeof schema === "object") {
    // raw JSON Schema (MCP-provided): inject the same budget field as a property
    const raw = schema as Record<string, unknown>;
    return {
      ...raw,
      properties: { ...((raw.properties as Record<string, unknown>) ?? {}), timeoutMs: { ...jsonTimeoutField } },
    };
  }
  return schema;
}

/** deterministic JSON key (sorted object keys) for the repeat-call ledger */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce((acc, key) => {
          acc[key] = (v as Record<string, unknown>)[key];
          return acc;
        }, {} as Record<string, unknown>);
    }
    return v;
  });
}

export interface RuntimeGateOptions {
  maxConcurrent?: number;
  queueWaitMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
}

export class AgentRuntime {
  private metrics = new Map<string, ToolMetrics>();
  /** per-turn repeat-call ledger; the ResultCollector identifies the turn */
  private ledgers = new WeakMap<object, Map<string, number>>();
  private breakers = new Map<string, CircuitBreaker>();
  private readonly gate: Semaphore;
  private readonly queueWaitMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;

  constructor(
    private readonly tools: () => ToolDefinition[],
    opts: RuntimeGateOptions = {},
  ) {
    this.gate = new Semaphore(opts.maxConcurrent ?? config.tools.maxConcurrent, "tools");
    this.queueWaitMs = opts.queueWaitMs ?? config.tools.queueWaitMs;
    this.breakerThreshold = opts.breakerThreshold ?? config.tools.breakerThreshold;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? config.tools.breakerCooldownMs;
  }

  listToolDefs(names?: string[]): ToolDefinition[] {
    const all = this.tools();
    if (!names) return all;
    const allow = new Set(names);
    return all.filter((t) => allow.has(t.name));
  }

  /** 按运行上下文构建 AI SDK tools（ctx 闭包注入，LLM 不可见）；names 限定该 agent 可用的工具 */
  buildSdkTools(ctx: ToolRunContext, names?: string[]): Record<string, Tool> {
    const out: Record<string, Tool> = {};
    for (const def of this.listToolDefs(names)) {
      const schema = withTimeoutArg(def.inputSchema);
      // zod schemas pass natively; raw JSON Schema (MCP tools) needs the ai jsonSchema() wrapper
      const inputSchema =
        schema instanceof ZodType ? schema : jsonSchema<Record<string, unknown>>(schema as Record<string, unknown>);
      out[def.name] = tool({
        description: def.description,
        inputSchema,
        execute: async (args: unknown) => {
          const output = await this.execute(def, args, ctx);
          return output.content;
        },
      }) as unknown as Tool;
    }
    return out;
  }

  private getMetrics(name: string): ToolMetrics {
    let m = this.metrics.get(name);
    if (!m) {
      m = { calls: 0, errors: 0, timeouts: 0, busy: 0, shortCircuited: 0, totalMs: 0 };
      this.metrics.set(name, m);
    }
    return m;
  }

  private breakerFor(name: string): CircuitBreaker {
    let b = this.breakers.get(name);
    if (!b) {
      b = new CircuitBreaker(this.breakerThreshold, this.breakerCooldownMs);
      this.breakers.set(name, b);
    }
    return b;
  }

  async execute(def: ToolDefinition, rawArgs: unknown, ctx: ToolRunContext): Promise<ToolOutput> {
    // strip the model-controlled budget before anything else (tools never see it)
    const { timeoutMs, ...args } = (rawArgs ?? {}) as Record<string, unknown> & { timeoutMs?: number };

    // 1. tool-level breaker: consecutive failures/timeouts → short-circuit until cooldown
    const breaker = this.breakerFor(def.name);
    if (breaker.isTripped) {
      const m = this.getMetrics(def.name);
      m.shortCircuited += 1;
      const secs = Math.ceil(breaker.recoveryInMs / 1000);
      log.warn(`[TOOL] ${def.name} short-circuited by breaker (recovery in ~${secs}s)`);
      return {
        content: `工具 ${def.name} 连续失败已熔断，约 ${secs}s 后自动恢复。请改用其他方式回答，或如实告知用户该功能暂不可用。`,
      };
    }

    // 2. repeat-call gate: identical tool + args beyond the limit → reject without executing
    let ledger = this.ledgers.get(ctx.collector);
    if (!ledger) {
      ledger = new Map<string, number>();
      this.ledgers.set(ctx.collector, ledger);
    }
    const callKey = `${def.name}:${stableKey(args)}`;
    const seen = (ledger.get(callKey) ?? 0) + 1;
    ledger.set(callKey, seen);
    if (seen > config.agent.toolRepeatLimit) {
      log.warn(`[TOOL] ${def.name} repeat call #${seen} rejected (limit=${config.agent.toolRepeatLimit})`);
      return {
        content: `工具 ${def.name} 以完全相同的参数已调用 ${seen - 1} 次，结果不会变化。请停止重复调用，基于已有结果继续回答或换个思路。`,
      };
    }

    // 3. concurrency slot: bounded wait, then fail fast (shallow queue, no deep queuing)
    const slot = await this.gate.acquire(this.queueWaitMs);
    if (!slot) {
      const m = this.getMetrics(def.name);
      m.busy += 1;
      log.warn(`[TOOL] ${def.name} busy: no slot within ${this.queueWaitMs}ms (running=${this.gate.running}/${this.gate.max})`);
      return {
        content: `系统繁忙：工具 ${def.name} 的执行槽已满（并发上限 ${this.gate.max}），等待 ${this.queueWaitMs}ms 未获得槽位。请稍后重试，或告知用户稍等片刻再试。`,
      };
    }

    const m = this.getMetrics(def.name);
    const started = Date.now();
    m.calls += 1;
    try {
      // 4. unified budget enforcement: the manager clamps, aborts and deletes on expiry
      const outcome = await timeoutManager.run(def.name, timeoutMs, (signal) =>
        Promise.resolve(def.execute(args, ctx, signal)),
      );
      if (!outcome.ok) {
        m.timeouts += 1;
        breaker.recordFailure();
        const secs = Math.round(outcome.budgetMs / 1000);
        log.warn(`[TOOL] ${def.name} timed out after ${outcome.budgetMs}ms`);
        return {
          content: `工具 ${def.name} 执行超时（${secs}s）。如该任务确实需要更长时间，可用更大的 timeoutMs 重试（上限 1 小时），或把任务拆小。`,
        };
      }
      const raw = await Promise.resolve(outcome.value);
      const output = typeof raw === "string" ? { content: raw } : raw;
      ctx.collector.pushSources(output.sources);
      ctx.collector.pushArtifacts(output.artifacts);
      breaker.recordSuccess();
      return output;
    } catch (err) {
      m.errors += 1;
      breaker.recordFailure();
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[TOOL] ${def.name} failed: ${message}`);
      return { content: `工具执行失败: ${message}` };
    } finally {
      slot();
      m.totalMs += Date.now() - started;
      this.metrics.set(def.name, m);
    }
  }

  monitor(): Record<string, ToolMetrics> {
    return Object.fromEntries(this.metrics);
  }

  /** observability: concurrency gate + per-tool breaker states (for /agent/runtime) */
  gateStats(): { max: number; running: number; waiting: number } {
    return { max: this.gate.max, running: this.gate.running, waiting: this.gate.waiting };
  }

  breakerStates(): Record<string, { state: string; failures: number; recoveryInMs: number }> {
    return Object.fromEntries(
      [...this.breakers.entries()].map(([name, b]) => [
        name,
        { state: b.state, failures: b.failures, recoveryInMs: b.recoveryInMs },
      ]),
    );
  }
}
