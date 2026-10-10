import { generateText } from "ai";
import { aiTelemetry } from "../llm/tracing.js";
import { config } from "../config/index.js";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";
import type { ChatSessionRepository } from "../repository/persistence.js";

const log = createLogger("TITLE");

/**
 * Session title generation (mirrors Python's background title task): fired after the
 * first turn of a session completes; one cheap LLM call, fire-and-forget. Sessions
 * already carrying a title are skipped (first query wins).
 */
export async function generateTitle(
  sessions: ChatSessionRepository,
  prompts: PromptRegistry,
  sessionId: string,
  firstQuery: string,
): Promise<string | null> {
  try {
    const session = await sessions.getOrCreate(sessionId);
    if (session.title) return null;
    const result = await generateText({
      model: createGatewayModel("title_gen"),
      system: prompts.render("title", {}),
      prompt: firstQuery.slice(0, 300),
      temperature: 0.3,
      ...aiTelemetry("title.generate"),
      abortSignal: AbortSignal.timeout(10_000),
    });
    const title = result.text
      .trim()
      .replace(/^["'「『]+|["'」』.。]+$/g, "")
      .slice(0, 30);
    if (!title) {
      log.warn(`[TITLE] empty title for session=${sessionId}, keeping untitled`);
      return null;
    }
    await sessions.rename(sessionId, title);
    log.info(`[TITLE] session=${sessionId} title=${title}`);
    return title;
  } catch (err) {
    log.warn(`[TITLE] session=${sessionId} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
