import { streamText, stepCountIs, type ModelMessage, type UserContent, type LanguageModel } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { config } from "../config/index.js";
import { maxOutputTokensFor } from "../utils/degrade.js";
import { createGatewayModel } from "../llm/provider.js";
import { ResultCollector } from "../context/types.js";
import type { AgentRuntime } from "../tools/runtime.js";
import type { SseFrame } from "../transport/sse.js";
import type { Agent, AgentInvokeInput } from "./types.js";
import { createLogger } from "../logger.js";
import { buildAgentContextSections } from "./context-sections.js";
import type { AgentContextRepository } from "../repository/agent-context.js";
import type { ConversationSummary } from "../repository/persistence.js";
import type { ContextCompressionService } from "../services/context-compression.js";

/** Stop condition factory: ends the ReAct loop once the given tool was called (e.g. ask_user). */
export function stopOnToolCall(toolName: string) {
  return ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName: string }> }> }) =>
    steps.some((s) => (s.toolCalls ?? []).some((c) => c.toolName === toolName));
}

/**
 * Generic ReAct agent factory: streamText + stopWhen(stepCountIs) drives the loop,
 * fullStream events are translated directly into SSE frames. Shared by all LLM agents (main / memory etc.).
 */
export interface ReactAgentOptions {
  name: string;
  description: string;
  runtime: AgentRuntime;
  /** Tool names available to this agent (mirrors Python runtime.list_tool_defs(names)) */
  toolNames: string[];
  /** Gateway billing label (purpose) */
  purpose: string;
  buildSystemPrompt(input: AgentInvokeInput): Promise<string>;
  /**
   * Persistent per-agent context binding (sub-agents): own distilled exchanges are
   * re-injected on every run and survive across runs (run state done ≠ context gone).
   * main agent omits this — its persistent context is the session message store.
   */
  context?: AgentContextBinding;
  /** model override (tests inject a mock; production defaults to the gateway model) */
  model?: LanguageModel;
}

/** Wiring for a sub-agent's private context + read access to the shared session summary. */
export interface AgentContextBinding {
  port: AgentContextRepository;
  /** shared context reader: session-level rolling summary only (never raw transcripts of other agents) */
  sharedSummary?: (sessionId: string) => Promise<ConversationSummary | undefined>;
  compression?: ContextCompressionService;
}

interface AttemptOutcome {
  hadError: boolean;
  errorMessage: string;
  retryable: boolean;
  fullText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Retryable-failure classification (mirrors Python classify_error): connectivity /
 * rate-limit / 5xx / timeout → retry the whole attempt; auth / bad request / context
 * length → fatal, fail the turn immediately.
 */
export function isRetryableError(message: string): boolean {
  if (/status code: 40[134]|invalid api key|unauthorized|forbidden|context length|invalid request/i.test(message)) {
    return false;
  }
  return /timeout|timed out|econn|enotfound|fetch failed|network|socket|\b429\b|rate.?limit|overloaded|status code: 5\d\d|internal server error/i.test(
    message,
  );
}

/** Context-window exhaustion gets its own fallback (history trim + one retry), not the generic fatal path. */
export function isContextLengthError(message: string): boolean {
  return /context length|context window|maximum context|too many tokens|token limit|prompt is too long/i.test(message);
}

/** Compact single-line args preview for the step timeline (truncated). */
function compactArgs(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    return "[unserializable]";
  }
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

export function createReactAgent(opts: ReactAgentOptions): Agent {
  async function* run(input: AgentInvokeInput): AsyncGenerator<SseFrame> {
    const collector = new ResultCollector();
    const ctx = {
      uid: input.uid,
      chatSessionId: input.chatSessionId,
      scope: input.scope,
      collector,
    };
    const tools = opts.runtime.buildSdkTools(ctx, opts.toolNames);

    let system = await opts.buildSystemPrompt(input);
    const binding = input.chatSessionId ? opts.context : undefined;
    let ownEntries: Awaited<ReturnType<AgentContextRepository["recent"]>> = [];

    // Inject own persistent context (recent distilled entries) as raw messages
    if (binding && input.chatSessionId) {
      try {
        ownEntries = await binding.port.recent(input.chatSessionId, opts.name, config.context.recentKeep);
      } catch (err) {
        createLogger("AGENT").warn(`[AGENT/${opts.name}] own-context read failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    /** multimodal history → ModelMessages (entries may carry images) */
    const toModelHistory = (h: AgentInvokeInput["history"]): ModelMessage[] =>
      h.map((m) => {
        if (m.images?.length) {
          return {
            role: m.role,
            content: [
              { type: "text" as const, text: m.content },
              ...m.images.map((image) => ({ type: "image" as const, image })),
            ],
          } as ModelMessage;
        }
        return { role: m.role, content: m.content } as ModelMessage;
      });
    // multimodal: attach this turn's images to the user message
    const userContent: UserContent = input.images?.length
      ? [
          { type: "text" as const, text: input.query },
          ...input.images.map((image) => ({ type: "image" as const, image })),
        ]
      : input.query;

    // Append context sections (own rolling summary + shared session summary) to the system prompt
    if (binding && input.chatSessionId) {
      try {
        const [ownSummary, sharedSummary] = await Promise.all([
          binding.port.getSummary(input.chatSessionId, opts.name),
          binding.sharedSummary?.(input.chatSessionId),
        ]);
        system += buildAgentContextSections(ownSummary, sharedSummary);
      } catch (err) {
        createLogger("AGENT").warn(`[AGENT/${opts.name}] context sections failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // One streaming attempt: consumes fullStream, forwards frames, returns the outcome.
    // Collector state (sources/artifacts/interactions) survives across attempts — tool
    // results from a failed attempt stay valid; only the assistant TEXT is reset.
    // `history` comes in per-attempt so the context-length fallback can trim it.
    async function* runAttempt(history: AgentInvokeInput["history"]): AsyncGenerator<SseFrame, AttemptOutcome> {
      const messages: ModelMessage[] = [
        ...ownEntries.map((e) => ({ role: e.role, content: e.content }) as ModelMessage),
        ...toModelHistory(history),
        { role: "user", content: userContent } as ModelMessage,
      ];
      const result = streamText({
        model: opts.model ?? createGatewayModel(opts.purpose, { uid: input.uid }),
        system,
        messages,
        tools,
        temperature: config.llm.temperature,
        // L1 省流：输出预算封顶（思考 token 计入输出，随之一并截断）
        ...(maxOutputTokensFor(input.uid) > 0 ? { maxOutputTokens: maxOutputTokensFor(input.uid) } : {}),
        ...aiTelemetry(`agent.${opts.name}`),
        // structured interaction ends the turn normally (round-based ask_user)
        stopWhen: [stepCountIs(config.agent.maxSteps), stopOnToolCall("ask_user")],
        onError: ({ error }) => {
          createLogger("AGENT").error(`[AGENT/${opts.name}] stream error: ${error instanceof Error ? error.message : String(error)}`);
        },
      });

      let stepNo = 0;
      // delegate_to_agent live tracking → `delegate` frames (frontend shows how
      // many sub-agents are running). Sequential loop keeps this at 0/1 today,
      // but the protocol counts properly if tool calls ever run in parallel.
      let activeDelegates = 0;
      let delegateSeq = 0;
      let lastDelegateAgent = "";
      /** toolCallId → start timestamp, for the done frame's durationMs */
      const toolStarts = new Map<string, number>();
      let hadError = false;
      let errorMessage = "";
      let fullText = "";
      let usage: AttemptOutcome["usage"];

      for await (const part of result.fullStream) {
        const p = part as Record<string, unknown> & { type: string };
        switch (p.type) {
          case "text-delta": {
            const text = (p.delta ?? p.text ?? "") as string;
            if (text) {
              fullText += text;
              yield { type: "chunk", content: text };
            }
            break;
          }
          case "reasoning-delta": {
            const text = (p.delta ?? p.text ?? "") as string;
            if (text) yield { type: "reasoning", content: text };
            break;
          }
          case "tool-call": {
            stepNo += 1;
            const toolInput = (p.input ?? p.args) as Record<string, unknown> | undefined;
            const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
            if (toolCallId) toolStarts.set(toolCallId, Date.now());
            yield {
              type: "step",
              step: {
                step: stepNo,
                action: String(p.toolName ?? ""),
                status: "start",
                query: typeof toolInput?.query === "string" ? (toolInput.query as string) : undefined,
                args: toolInput ? compactArgs(toolInput) : undefined,
              },
            };
            if (p.toolName === "delegate_to_agent" && typeof toolInput?.agent === "string") {
              lastDelegateAgent = toolInput.agent;
              delegateSeq += 1;
              activeDelegates += 1;
              yield { type: "delegate", agent: lastDelegateAgent, status: "start", active: activeDelegates, index: delegateSeq };
            }
            break;
          }
          case "tool-result": {
            const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
            const startedAt = toolStarts.get(toolCallId);
            yield {
              type: "step",
              step: {
                step: stepNo,
                action: String(p.toolName ?? ""),
                status: "done",
                durationMs: startedAt ? Date.now() - startedAt : undefined,
              },
            };
            if (p.toolName === "delegate_to_agent") {
              const toolInput = (p.input ?? p.args) as Record<string, unknown> | undefined;
              const agentName = typeof toolInput?.agent === "string" ? toolInput.agent : lastDelegateAgent;
              activeDelegates = Math.max(0, activeDelegates - 1);
              yield { type: "delegate", agent: agentName, status: "done", active: activeDelegates, index: delegateSeq };
            }
            break;
          }
          case "finish": {
            const u = (p.totalUsage ?? p.usage) as Record<string, unknown> | undefined;
            if (u && typeof u === "object") {
              const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
              usage = {
                inputTokens: num(u.inputTokens),
                outputTokens: num(u.outputTokens),
                totalTokens: num(u.totalTokens),
              };
            }
            break;
          }
          case "error": {
            hadError = true;
            const err = p.error;
            errorMessage =
              err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
            break;
          }
          default:
            break;
        }
      }
      return { hadError, errorMessage, retryable: hadError && isRetryableError(errorMessage), fullText, usage };
    }

    // Turn-level retry (mirrors Python error_node): retryable failures abort the attempt,
    // emit a `reset` frame (frontend clears streamed text) and re-run from scratch.
    let attempt = 0;
    let last: AttemptOutcome | null = null;
    let history = input.history;
    let contextTrimmed = false;
    while (true) {
      if (attempt > 0) yield { type: "reset" };
      const outcome = yield* runAttempt(history);
      last = outcome;
      if (!outcome.hadError) break;

      // context-length exhaustion → drop the older half of the history and retry
      // once (reset frame tells the client to clear streamed text). Only one trim:
      // if it still doesn't fit, the turn fails like any other fatal error.
      if (isContextLengthError(outcome.errorMessage) && history.length > 0 && !contextTrimmed) {
        contextTrimmed = true;
        history = history.slice(-Math.max(1, Math.ceil(history.length / 2)));
        attempt += 1;
        createLogger("AGENT").warn(`[AGENT/${opts.name}] context length exceeded, trimmed history to ${history.length} entries, retrying`);
        continue;
      }

      if (outcome.retryable && attempt < config.agent.turnRetries) {
        attempt += 1;
        createLogger("AGENT").warn(`[AGENT/${opts.name}] retryable error, retry attempt=${attempt}`);
        continue;
      }
      break;
    }
    const { fullText, usage } = last!;

    // Persist the distilled exchange into this agent's private context (write-side
    // pollution control: only task → final answer, never tool-call noise), then
    // schedule its own compression.
    if (binding && input.chatSessionId && fullText.trim()) {
      const now = Date.now();
      try {
        await binding.port.append(input.chatSessionId, opts.name, {
          role: "user",
          content: input.query.slice(0, 2000),
          createdAt: now,
        });
        await binding.port.append(input.chatSessionId, opts.name, {
          role: "assistant",
          content: fullText.slice(0, 4000),
          createdAt: now,
        });
        binding.compression?.scheduleAgent(input.chatSessionId, opts.name, binding.port);
      } catch (err) {
        createLogger("AGENT").warn(`[AGENT/${opts.name}] own-context persist failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stream tail: artifact → sources → interact → error? → done (mirrors the Python agent_sse tail order;
    // the structured interaction frame lands right before the closing frames so the frontend renders it last)
    if (collector.artifacts.length > 0) {
      yield { type: "artifact", artifacts: collector.artifacts };
    }
    yield { type: "sources", sources: collector.sources.slice(0, 5) };
    for (const interaction of collector.interactions) {
      yield { type: "interact", interact: interaction };
    }
    if (last!.hadError) {
      yield { type: "error", message: last!.errorMessage || "agent 执行失败" };
    } else if (!fullText.trim() && collector.interactions.length === 0 && collector.artifacts.length === 0) {
      // loop ended without an answer (max steps reached / model produced nothing) —
      // an empty assistant bubble is worse than an explicit failure
      yield { type: "error", message: "模型未返回有效内容（可能已达最大工具步数），请重试或换个问法" };
    }
    yield { type: "usage", usage: usage ?? {} };
    yield { type: "done" };
  }

  return {
    name: opts.name,
    description: opts.description,
    run,
  };
}
