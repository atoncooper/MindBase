import { NodeSDK } from "@opentelemetry/sdk-node";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";

/**
 * LangSmith tracing via the AI SDK's native OpenTelemetry instrumentation:
 * every streamText/generateText call site spreads `aiTelemetry(...)`; spans are
 * exported over OTLP HTTP to LangSmith (shared LANGSMITH_* env with the Python
 * backend — one .env drives both services).
 *
 * Gating: no LANGSMITH_API_KEY → `isEnabled: false` on every call site and no
 * provider is registered (zero overhead). Privacy note (§十二 spirit): spans
 * carry prompt/completion content to LangSmith, an external SaaS — the
 * integration is strictly opt-in via the key.
 */

const log = createLogger("TRACING");

let sdk: NodeSDK | null = null;

export function isTracingEnabled(): boolean {
  return Boolean(config.langsmith.apiKey);
}

/** Shared `experimental_telemetry` option for AI SDK call sites — spread into the request options. */
export function aiTelemetry(functionId: string, metadata?: Record<string, string>) {
  return {
    experimental_telemetry: {
      isEnabled: isTracingEnabled(),
      functionId,
      ...(metadata ? { metadata } : {}),
    },
  };
}

/** Register the global OTel tracer provider exporting to LangSmith. No-op without a key (or when already started). */
export function setupTracing(opts: { spanProcessors?: SpanProcessor[] } = {}): void {
  if (sdk || !isTracingEnabled()) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "mindbase-app-ts",
      "langsmith.project": config.langsmith.projectName,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.langsmith.baseUrl.replace(/\/$/, "")}/otel/v1/traces`,
      headers: {
        "x-api-key": config.langsmith.apiKey,
        "langsmith-project": config.langsmith.projectName,
      },
    }),
    ...(opts.spanProcessors ? { spanProcessors: opts.spanProcessors } : {}),
  });
  sdk.start();
  log.info(`[TRACING] langsmith enabled project=${config.langsmith.projectName}`);
}

/**
 * Flush and unregister the provider (graceful shutdown). trace.disable() clears
 * the OTel global so a later setupTracing() can register again (tests register
 * per-file; production calls this once at process exit).
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
  trace.disable();
}
