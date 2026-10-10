import { generateText } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { config } from "../config/index.js";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";
import type { ChatSessionRepository, MessageRepository } from "../repository/persistence.js";

const log = createLogger("COMPRESS");

/**
 * Context compression service (mirrors Python get_conversation_context + background summarizer):
 * after a turn finishes, if done messages beyond the recent window exceed the threshold,
 * merge [already-summarized → total - recentKeep] into a new rolling summary via one LLM call.
 * Pure business logic — LLM transport is injectable for tests; triggered fire-and-forget by ChatService.
 */
export class ContextCompressionService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly sessions: ChatSessionRepository,
    private readonly messages: MessageRepository,
    private readonly prompts: PromptRegistry,
    private readonly summarize: (system: string, prompt: string) => Promise<string> = async (system, prompt) => {
      const result = await generateText({
        model: createGatewayModel("context_compress"),
        system,
        prompt,
        temperature: 0.3,
        ...aiTelemetry("context.compress"),
        abortSignal: AbortSignal.timeout(30_000),
      });
      return result.text.trim();
    },
  ) {}

  /** Fire-and-forget entry point; concurrent runs for the same session are deduplicated. */
  schedule(sessionId: string): void {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    void this.maybeCompress(sessionId)
      .catch((err) => {
        log.error(`[COMPRESS] session=${sessionId} failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
      });
  }

  /** Returns the saved summary when compression ran, null when below threshold / nothing to do. */
  async maybeCompress(sessionId: string): Promise<{ summary: string; summarizedCount: number } | null> {
    const { compressThreshold, recentKeep } = config.context;
    const total = await this.messages.countDone(sessionId);
    const prev = await this.sessions.getSummary(sessionId);
    const already = prev?.summarizedCount ?? 0;

    // compress the slice [already, total - recentKeep); require enough new material
    const target = total - recentKeep;
    if (target - already < compressThreshold) return null;

    const msgs = await this.messages.listDone(sessionId, already, target - already);
    if (msgs.length === 0) return null;

    const transcript = msgs
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 2000)}`)
      .join("\n\n");
    const previous = prev?.summary ?? "（无）";
    const prompt = `# 已有摘要\n${previous}\n\n# 新增对话\n${transcript}`;

    const summary = await this.summarize(this.prompts.render("compress", {}), prompt);
    const saved = { summary, summarizedCount: target, updatedAt: Date.now() };
    await this.sessions.saveSummary(sessionId, saved);
    log.info(`[COMPRESS] session=${sessionId} summarized_upto=${target} chars=${summary.length}`);
    return saved;
  }

  /**
   * Per-agent context compression: same rolling-summary flow, but over the agent's own
   * distilled entries (session-scoped, isolated per agentName). After summarizing,
   * raw entries are trimmed so the store stays bounded.
   */
  async maybeCompressAgent(
    sessionId: string,
    agentName: string,
    port: import("../repository/agent-context.js").AgentContextRepository,
  ): Promise<{ summary: string; summarizedCount: number } | null> {
    const { compressThreshold, recentKeep } = config.context;
    const total = await port.countEntries(sessionId, agentName);
    const prev = await port.getSummary(sessionId, agentName);
    const already = prev?.summarizedCount ?? 0;

    const target = total - recentKeep;
    if (target - already < compressThreshold) return null;

    const entries = await port.listEntries(sessionId, agentName, already, target - already);
    if (entries.length === 0) return null;

    const transcript = entries
      .map((e) => `${e.role === "user" ? "任务" : "结果"}：${e.content.slice(0, 2000)}`)
      .join("\n\n");
    const previous = prev?.summary ?? "（无）";
    const prompt = `# 已有摘要\n${previous}\n\n# 新增对话\n${transcript}`;

    const summary = await this.summarize(this.prompts.render("compress", {}), prompt);
    const saved = { summary, summarizedCount: target, updatedAt: Date.now() };
    await port.saveSummary(sessionId, agentName, saved);
    await port.trim(sessionId, agentName, recentKeep);
    log.info(`[COMPRESS] agent=${agentName} session=${sessionId} summarized_upto=${target} chars=${summary.length}`);
    return saved;
  }

  /** Fire-and-forget per-agent compression; dedupe key = session:agent. */
  scheduleAgent(sessionId: string, agentName: string, port: import("../repository/agent-context.js").AgentContextRepository): void {
    const key = `${sessionId}:${agentName}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.maybeCompressAgent(sessionId, agentName, port)
      .catch((err) => {
        log.error(`[COMPRESS] agent=${agentName} session=${sessionId} failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
  }
}
