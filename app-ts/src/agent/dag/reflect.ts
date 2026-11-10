import { generateText } from "ai";
import { createGatewayModel } from "../../llm/provider.js";
import { aiTelemetry } from "../../llm/tracing.js";
import { config } from "../../config/index.js";
import type { PromptRegistry } from "../prompts/loader.js";
import { createLogger } from "../../logger.js";

const log = createLogger("PLAN_REFLECT");

export interface ReflectInput {
  goal: string;
  title: string;
  task: string;
  acceptance: string;
  output: string;
  upstream: string;
}

export interface ReflectResult {
  pass: boolean;
  critique: string;
}

/**
 * Cheap acceptance review for one DAG node. One LLM call, no tools, strict
 * JSON output; a malformed answer fails open (pass=true) so a reflection bug
 * never blocks the whole plan.
 */
export class ReflectService {
  constructor(private readonly prompts: PromptRegistry) {}

  async review(input: ReflectInput): Promise<ReflectResult> {
    const acceptance = input.acceptance.trim();
    if (!acceptance) return { pass: true, critique: "" };
    try {
      const result = await generateText({
        model: createGatewayModel("plan_reflect"),
        system: this.prompts.render("agents/reflect", {
          GOAL: input.goal,
          TITLE: input.title,
          TASK: input.task,
          ACCEPTANCE: acceptance,
          OUTPUT: input.output.slice(0, 8000),
          UPSTREAM: input.upstream.slice(0, 4000),
        }),
        prompt: "请只输出 JSON：{\"pass\": true|false, \"critique\": \"\"}",
        temperature: 0,
        maxOutputTokens: 300,
        abortSignal: AbortSignal.timeout(config.agent.plan.reflectTimeoutMs),
        ...aiTelemetry("plan.reflect"),
      });
      const text = result.text.trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("no JSON object");
      const parsed = JSON.parse(text.slice(start, end + 1)) as { pass?: unknown; critique?: unknown };
      if (typeof parsed.pass !== "boolean") throw new Error("pass is not boolean");
      return {
        pass: parsed.pass,
        critique: typeof parsed.critique === "string" ? parsed.critique.slice(0, 800) : "",
      };
    } catch (err) {
      log.warn("[PLAN_REFLECT] review failed, fail-open: " + (err instanceof Error ? err.message : String(err)));
      return { pass: true, critique: "" };
    }
  }
}
