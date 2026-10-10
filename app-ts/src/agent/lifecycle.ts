import { config } from "../config/index.js";
import { CircuitBreaker } from "./circuit.js";
import type { Agent, AgentFactory, AgentInvokeInput } from "./types.js";
import type { SseFrame } from "../transport/sse.js";
import type { Source } from "../context/types.js";
import { createLogger } from "../logger.js";

/**
 * AgentLifecycleManager (mirrors Python lifecycle/manager.py):
 * factory registration + per-agent circuit breaker + per-session mutual exclusion (Promise-chain lock).
 * All exceptions are converted into error frames, never rethrown upward.
 */
const log = createLogger("LIFECYCLE");

/** Per-agent runtime statistics (agent_metrics on /agent/runtime). */
export interface AgentRunStat {
  runs: number;
  ok: number;
  failed: number;
  /** turn-level retries observed (reset frames) */
  retries: number;
  /** calls rejected because the circuit breaker was open */
  breakerTripped: number;
  /** currently running invocations (stream + reentrant) */
  active: number;
  totalMs: number;
  lastDurationMs?: number;
  /** last observed error (≤200 chars; may be from a recovered attempt) */
  lastError?: string;
  lastRunAt?: string;
}

export class AgentLifecycleManager {
  private readonly factories = new Map<string, AgentFactory>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly sessionLocks = new Map<string, Promise<unknown>>();
  private readonly stats = new Map<string, AgentRunStat>();

  register(name: string, factory: AgentFactory): void {
    this.factories.set(name, factory);
    this.breakers.set(name, new CircuitBreaker(config.agent.circuitFailureThreshold, config.agent.circuitCooldownMs));
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  breakerState(name: string): string {
    return this.breakers.get(name)?.state ?? "unknown";
  }

  registeredAgents(): Array<{ name: string; breaker: string }> {
    return [...this.factories.keys()].map((name) => ({
      name,
      breaker: this.breakerState(name),
    }));
  }

  /** Per-agent run statistics (agent_metrics on /agent/runtime). */
  agentStats(): Record<string, AgentRunStat> {
    const out: Record<string, AgentRunStat> = {};
    for (const [name, stat] of this.stats) {
      out[name] = { ...stat, lastError: stat.lastError };
    }
    return out;
  }

  /** Per-agent circuit breaker states (same shape as the tool-level breakers view). */
  agentBreakers(): Record<string, { state: string; failures: number; recoveryInMs: number }> {
    return Object.fromEntries(
      [...this.breakers.entries()].map(([name, b]) => [
        name,
        { state: b.state, failures: b.failures, recoveryInMs: b.recoveryInMs },
      ]),
    );
  }

  /** Number of session locks currently held (one running turn per session). */
  activeLocks(): number {
    return this.activeLockCount;
  }

  private stat(name: string): AgentRunStat {
    let s = this.stats.get(name);
    if (!s) {
      s = { runs: 0, ok: 0, failed: 0, retries: 0, breakerTripped: 0, active: 0, totalMs: 0 };
      this.stats.set(name, s);
    }
    return s;
  }

  private recordStart(name: string): void {
    this.stat(name).active += 1;
  }

  private recordEnd(name: string, startedAt: number, outcome: "ok" | "failed", retries: number, error?: string): void {
    const s = this.stat(name);
    s.active = Math.max(0, s.active - 1);
    s.runs += 1;
    if (outcome === "ok") s.ok += 1;
    else s.failed += 1;
    s.retries += retries;
    const durationMs = Date.now() - startedAt;
    s.totalMs += durationMs;
    s.lastDurationMs = durationMs;
    s.lastRunAt = new Date().toISOString();
    if (error) {
      s.lastError = error.length > 200 ? `${error.slice(0, 200)}…` : error;
    }
  }

  private recordRejected(name: string): void {
    this.stat(name).breakerTripped += 1;
  }

  /** Streaming call: per-session serialization + circuit breaker; emits a frame stream, exceptions collapse into an error frame. */
  async *stream(agentName: string, sessionId: string, input: AgentInvokeInput): AsyncGenerator<SseFrame> {
    const breaker = this.breakers.get(agentName);
    if (!breaker) {
      yield { type: "error", message: `agent "${agentName}" 未注册` };
      yield { type: "done" };
      return;
    }
    if (breaker.isTripped) {
      this.recordRejected(agentName);
      yield { type: "error", message: `agent "${agentName}" 熔断中，请稍后重试` };
      yield { type: "done" };
      return;
    }

    const release = await this.acquireLock(sessionId);
    const startedAt = Date.now();
    this.recordStart(agentName);
    let retries = 0;
    let lastError: string | undefined;
    let sawError = false;
    try {
      const factory = this.factories.get(agentName)!;
      const agent: Agent = factory();
      for await (const frame of agent.run(input)) {
        if (frame.type === "error") {
          // terminal error frame — the agent converts its own failures into these,
          // so this is the breaker's real failure signal (never an exception)
          sawError = true;
          breaker.recordFailure();
          lastError = frame.message;
        } else if (frame.type === "reset") {
          retries += 1;
        }
        yield frame;
      }
      // success only when the turn ended cleanly; unconditional success would
      // erase the breaker's failure count and make it dead for frame-emitting agents
      if (sawError) {
        this.recordEnd(agentName, startedAt, "failed", retries, lastError);
      } else {
        breaker.recordSuccess();
        this.recordEnd(agentName, startedAt, "ok", retries, lastError);
      }
    } catch (err) {
      breaker.recordFailure();
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[LIFECYCLE] agent=${agentName} session=${sessionId} failed: ${message}`);
      this.recordEnd(agentName, startedAt, "failed", retries, message);
      yield { type: "error", message };
      yield { type: "done" };
    } finally {
      release();
    }
  }

  /**
   * Re-entrant call (mirrors Python invoke_reentrant): lets delegate_to_agent invoke sub-agents from inside the graph.
   * Does not take the session lock (the Promise-chain lock is not re-entrant; re-entry would deadlock); the circuit breaker still applies.
   * Non-streaming: collapses into {content, sources, failed}.
   */
  async invokeReentrant(
    agentName: string,
    sessionId: string,
    input: AgentInvokeInput,
  ): Promise<{ content: string; sources: Source[]; failed: boolean }> {
    const breaker = this.breakers.get(agentName);
    if (!breaker) {
      return { content: `agent "${agentName}" 未注册`, sources: [], failed: true };
    }
    if (breaker.isTripped) {
      this.recordRejected(agentName);
      return { content: `agent "${agentName}" 熔断中，请稍后重试`, sources: [], failed: true };
    }

    const factory = this.factories.get(agentName)!;
    const agent: Agent = factory();
    const startedAt = Date.now();
    this.recordStart(agentName);
    let content = "";
    const sources: Source[] = [];
    let failed = false;
    let lastError: string | undefined;
    try {
      for await (const frame of agent.run(input)) {
        if (frame.type === "chunk") content += frame.content;
        else if (frame.type === "sources") sources.push(...frame.sources);
        else if (frame.type === "error") {
          failed = true;
          breaker.recordFailure();
          lastError = frame.message;
          content = content || frame.message;
        }
      }
      if (!failed) breaker.recordSuccess();
      this.recordEnd(agentName, startedAt, failed ? "failed" : "ok", 0, lastError);
    } catch (err) {
      breaker.recordFailure();
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      this.recordEnd(agentName, startedAt, "failed", 0, message);
      content = `子 agent 执行失败: ${message}`;
    }
    return { content, sources, failed };
  }

  /** Promise-chain lock: serializes turns for the same session.
   * The returned promise resolves after the previous lock holder calls release(); the caller awaits before entering the critical section,
   * and calls the returned release() when done. The map entry self-cleans when
   * the last holder releases (the chain promise would otherwise accumulate per session).
   */
  private activeLockCount = 0;

  private acquireLock(sessionId: string): Promise<() => void> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.sessionLocks.set(sessionId, chained);
    // resolve on `prev` (NOT on gate): the caller must receive the release fn
    // while it holds the lock — chaining onto gate would deadlock
    return prev.then(() => {
      this.activeLockCount += 1;
      return () => {
        this.activeLockCount = Math.max(0, this.activeLockCount - 1);
        release();
        if (this.sessionLocks.get(sessionId) === chained) {
          this.sessionLocks.delete(sessionId);
        }
      };
    });
  }
}
