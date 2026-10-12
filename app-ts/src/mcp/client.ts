import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CompatibilityCallToolResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../logger.js";

/**
 * MCP client facade over the **official TypeScript SDK** (`@modelcontextprotocol/sdk`):
 * protocol + streamable-http transport live in the SDK; this module owns only the
 * integration policy our tools rely on —
 *
 *   - short-session mode: every operation opens a fresh Client+transport
 *     (SDK handshake) and tears it down after (terminateSession DELETE → close),
 *     matching app-board-mcp's per-session state model;
 *   - never-throw facade with mapped error messages (tool layers render them
 *     straight back to the LLM); `errorKind` separates transport failures
 *     (throwable → feeds the runtime circuit breaker) from server-side tool
 *     errors (isError → text for the model to reason about);
 *   - identity rides the `X-Uid` header per operation (§2.12 red line: uid never
 *     enters LLM-visible tool arguments); auth headers are static per instance;
 *   - cancellation: `signal` aborts the in-flight request (TimeoutManager /
 *     user stop), while teardown still runs so the session is GC'd server-side;
 *   - observability: `[MCP]` logs + per-instance call metrics (`mcpClientStats`,
 *     surfaced on /agent/runtime). Log/metric policy: tool name, duration,
 *     content size, uid — **never** tool arguments, result content or auth headers.
 *
 * Deliberate stances: no client-side auto-retry (tools/call is not idempotent;
 * retries belong to the agent loop and the tool-level breaker); no long-lived
 * sessions (construct an SDK `Client` directly at the composition root if a
 * server ever needs one); server→client notifications are logged at debug and
 * otherwise ignored (short sessions leave them no lifetime to matter).
 */

const log = createLogger("MCP");

const MCP_CLIENT_INFO = { name: "mindbase-app-ts", version: "0.1.0" } as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LOGGED_ERROR = 200;

export interface McpClientOptions {
  /** instance name for logs/metrics (e.g. "board") */
  name?: string;
  url: string;
  /** per-request + handshake timeout (SDK RequestOptions.timeout), default 30s */
  timeoutMs?: number;
  /** static headers sent with every request (auth: Bearer token / apikey — MCP server 服务模式认 `apikey` 头) */
  defaultHeaders?: Record<string, string>;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

export interface McpToolCallOptions {
  /** forwarded as the X-Uid request header */
  uid?: string;
  /** aborts the in-flight request (tool budget / user stop); teardown still runs */
  signal?: AbortSignal;
}

export type McpErrorKind = "transport" | "tool";

/** Tool-facing result — the facade never throws. */
export interface McpCallResult {
  ok: boolean;
  /** text content blocks concatenated */
  content: string;
  error?: string;
  /**
   * transport = client/network/timeout/cancel (callers may throw so the runtime
   * breaker sees it); tool = server-side isError result (business error, keep
   * as text for the LLM).
   */
  errorKind?: McpErrorKind;
  /** MCP structuredContent passthrough when the tool provides one */
  structuredContent?: unknown;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolListCallResult {
  ok: boolean;
  tools: McpToolInfo[];
  nextCursor?: string;
  error?: string;
}

export interface McpPingResult {
  ok: boolean;
  error?: string;
}

export interface McpClientStat {
  name: string;
  url: string;
  calls: number;
  ok: number;
  /** transport-level failures (client/network/timeout) */
  failed: number;
  /** server-side isError results (business errors, not infrastructure) */
  toolErrors: number;
  cancelled: number;
  totalDurationMs: number;
  lastDurationMs?: number;
  /** truncated to MAX_LOGGED_ERROR chars; never contains args or content */
  lastError?: string;
  lastCallAt?: string;
}

const statRegistry = new Map<string, McpClientStat>();

/** Per-instance call metrics snapshot (surfaced on /agent/runtime). */
export function mcpClientStats(): McpClientStat[] {
  return [...statRegistry.values()].map((s) => ({ ...s }));
}

export class McpClient {
  readonly name: string;

  constructor(private readonly opts: McpClientOptions) {
    this.name = opts.name ?? "mcp";
  }

  async callTool(name: string, args: Record<string, unknown>, opts: McpToolCallOptions = {}): Promise<McpCallResult> {
    if (!this.opts.url) {
      return { ok: false, content: "", error: "MCP 端点未配置", errorKind: "transport" };
    }
    const startedAt = Date.now();
    let session: McpClientSession | null = null;
    try {
      session = await this.connect(opts.uid);
      // Compatibility schema: tolerates servers that return loose content shapes
      const result = await session.client.callTool(
        { name, arguments: args },
        CompatibilityCallToolResultSchema,
        { timeout: this.timeoutMs(), signal: opts.signal },
      );
      const text = textFromContent(result.content);
      if (result.isError) {
        const error = text || "MCP 工具返回错误";
        this.record(`tool=${name}`, opts.uid, startedAt, "tool_error", error);
        return { ok: false, content: text, error, errorKind: "tool" };
      }
      this.record(`tool=${name} content_bytes=${text.length}`, opts.uid, startedAt, "ok");
      return { ok: true, content: text, structuredContent: result.structuredContent };
    } catch (err) {
      const cancelled = isAbortError(err);
      const error = errorMessage(err);
      this.record(`tool=${name}`, opts.uid, startedAt, cancelled ? "cancelled" : "failed", error);
      return { ok: false, content: "", error, errorKind: "transport" };
    } finally {
      if (session) await teardown(session, this.timeoutMs());
    }
  }

  /** Capability discovery (tools/list, with cursor pagination). Never throws. */
  async listTools(opts: McpToolCallOptions & { cursor?: string } = {}): Promise<McpToolListCallResult> {
    if (!this.opts.url) {
      return { ok: false, tools: [], error: "MCP 端点未配置" };
    }
    const startedAt = Date.now();
    let session: McpClientSession | null = null;
    try {
      session = await this.connect(opts.uid);
      const params = opts.cursor === undefined ? undefined : { cursor: opts.cursor };
      const result = await session.client.listTools(params, { timeout: this.timeoutMs(), signal: opts.signal });
      this.record(`op=tools/list tools=${result.tools.length}`, opts.uid, startedAt, "ok");
      return { ok: true, tools: result.tools, nextCursor: result.nextCursor };
    } catch (err) {
      const cancelled = isAbortError(err);
      const error = errorMessage(err);
      this.record(`op=tools/list`, opts.uid, startedAt, cancelled ? "cancelled" : "failed", error);
      return { ok: false, tools: [], error };
    } finally {
      if (session) await teardown(session, this.timeoutMs());
    }
  }

  /** Liveness probe: full short-session round trip (handshake → ping → close). Never throws. */
  async ping(opts: McpToolCallOptions = {}): Promise<McpPingResult> {
    if (!this.opts.url) {
      return { ok: false, error: "MCP 端点未配置" };
    }
    let session: McpClientSession | null = null;
    try {
      session = await this.connect(opts.uid);
      await session.client.ping({ timeout: this.timeoutMs() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      if (session) await teardown(session, this.timeoutMs());
    }
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Fresh Client + transport per operation. The SDK runs the initialize
   * handshake inside connect(); a failure there still tears the transport
   * down (DELETE fires when the server already assigned a session id).
   */
  private async connect(uid?: string): Promise<McpClientSession> {
    const headers: Record<string, string> = { ...this.opts.defaultHeaders };
    if (uid !== undefined) headers["X-Uid"] = String(uid);
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers },
      fetch: this.opts.fetchImpl,
    });
    const client = new Client(MCP_CLIENT_INFO);
    // server→client notifications are meaningless in a short session; log and drop
    client.fallbackNotificationHandler = (notification) => {
      log.debug(`[MCP] ${this.name} notification ${notification.method} (session-scoped, ignored)`);
      return Promise.resolve();
    };
    try {
      await client.connect(transport, { timeout: this.timeoutMs() });
    } catch (err) {
      await teardown({ transport, client }, this.timeoutMs());
      throw err;
    }
    return { transport, client };
  }

  /** Metrics + logs. Policy: names/sizes/durations only — never args, content or auth headers. */
  private record(detail: string, uid: string | undefined, startedAt: number, kind: "ok" | "failed" | "tool_error" | "cancelled", error?: string): void {
    const key = this.name;
    let stat = statRegistry.get(key);
    if (!stat) {
      stat = { name: key, url: this.opts.url, calls: 0, ok: 0, failed: 0, toolErrors: 0, cancelled: 0, totalDurationMs: 0 };
      statRegistry.set(key, stat);
    }
    const durationMs = Date.now() - startedAt;
    stat.calls += 1;
    if (kind === "ok") stat.ok += 1;
    else if (kind === "tool_error") stat.toolErrors += 1;
    else if (kind === "cancelled") stat.cancelled += 1;
    else stat.failed += 1;
    stat.totalDurationMs += durationMs;
    stat.lastDurationMs = durationMs;
    stat.lastCallAt = new Date().toISOString();
    if (error) stat.lastError = error.length > MAX_LOGGED_ERROR ? error.slice(0, MAX_LOGGED_ERROR) + "…" : error;

    const line = `[MCP] ${key} ${detail} kind=${kind} duration=${durationMs}ms uid=${uid ?? "-"}`;
    if (kind === "ok") log.info(line);
    else log.warn(error ? `${line} error=${error}` : line);
  }
}

interface McpClientSession {
  transport: StreamableHTTPClientTransport;
  client: Client;
}

/**
 * Session teardown, order matters: `terminateSession()` must run BEFORE
 * `client.close()` — close() aborts the transport's AbortController, which is
 * the signal the DELETE request would use, so a post-close DELETE can never
 * leave the gate. The whole teardown races a timeout so a hung endpoint never
 * stalls the tool result.
 */
async function teardown(session: McpClientSession, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await session.transport.terminateSession().catch(() => undefined);
        await session.client.close();
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // best effort: server-side session GC handles the rest
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Compatibility result's content is loosely typed — narrow at runtime. */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string") {
        return (c as { text: string }).text;
      }
      return undefined;
    })
    .filter((t): t is string => t !== undefined)
    .join("\n");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * SDK protocol-level errors (request timeout, server JSON-RPC error) carry
 * final, user-appropriate messages → surface verbatim; cancellation gets a
 * friendly message; anything else (HTTP failures, network errors) is prefixed
 * `MCP 调用失败`.
 */
/**
 * SDK protocol-level errors (request timeout, server JSON-RPC error) carry
 * final, user-appropriate messages → surface verbatim; cancellation gets a
 * friendly message (the SDK wraps the abort reason in an McpError whose
 * message names "AbortError" — and also sends notifications/cancelled to the
 * server, propagating the cancellation); anything else (HTTP failures,
 * network errors) is prefixed `MCP 调用失败`.
 */
function errorMessage(err: unknown): string {
  if (isAbortError(err) || (err instanceof McpError && err.message.includes("AbortError"))) {
    return "MCP 调用已取消";
  }
  if (err instanceof McpError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  return `MCP 调用失败: ${msg}`;
}
