/**
 * HttpCodeExecution: remote code sandbox backed by the app-sandbox control plane
 * .
 *
 * Wire contract:
 *  - POST {baseUrl}/v1/executions   body {language, code, timeoutMs?} → 202
 *    {executionId, leaseId, state}; identity rides X-Uid, credentials ride
 *    X-API-Key (service self-auth) and apikey (APISIX key-auth consumer).
 *  - GET  {baseUrl}/v1/executions/{id} → {status, exitCode, stdoutPreview,
 *    stderrPreview, artifacts:[{name,size,sha256,url}], errorCode}; terminal
 *    states are succeeded / failed / timed_out / canceled, any other state keeps
 *    polling until the local deadline.
 *
 * Failure policy (identical to the port contract): every transport error, non-2xx
 * response or local timeout resolves with `sandboxAvailable=false` and a Chinese
 * `error` — it never rejects, so the ReAct loop keeps running and the agent tells
 * the user the code was not actually executed.
 *
 * Fetch/clock/sleep are injectable so unit tests are fully offline and can drive
 * polling and the timeout deterministically.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logger.js";
import type {
  CodeExecutionArtifact,
  CodeExecutionPort,
  CodeExecutionRequest,
  CodeExecutionResult,
  CodeArtifactPort,
  CodeFilePort,
  CodeInfoPort,
  SandboxArtifactReadRequest,
  SandboxArtifactReadResult,
  CodeOutputPort,
  SandboxRuntimeInfo,
  SandboxOutputRequest,
  SandboxOutputResult,
  SandboxFileReadRequest,
  SandboxFileReadResult,
  SandboxFileWriteRequest,
  SandboxFileWriteResult,
} from "./code-execution.js";

const log = createLogger("SANDBOX");

/** Minimal fetch shape (injectable; defaults to the global fetch). */
export type SandboxFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Constructor options; production wiring reads them from `config.sandbox`. */
export interface HttpCodeExecutionOptions {
  /** app-sandbox base URL (APISIX internal route, no trailing /v1) */
  baseUrl: string;
  /** shared internal API key (APISIX consumer + app-sandbox auth) */
  apiKey: string;
  /** local deadline for create+poll (ms); the per-run budget is request.timeoutMs */
  timeoutMs: number;
  /** status poll interval (ms; clamped to >= 10 to avoid a hot loop) */
  pollIntervalMs: number;
  /** test seam; defaults to global fetch */
  fetchImpl?: SandboxFetch;
  /** test seam; defaults to setTimeout-based sleep */
  sleepImpl?: (ms: number) => Promise<void>;
  /** test seam; defaults to Date.now */
  nowImpl?: () => number;
  /** production: let an explicit/long request budget extend the local poll deadline */
  extendForRequestTimeout?: boolean;
  /** production: back off status polling for long runs (500ms → 3s) */
  adaptivePolling?: boolean;
}

/** Terminal execution states reported by the control plane. */
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "timedout",
  "timeout",
  "canceled",
  "cancelled",
]);

type CallFailureKind = "network" | "http" | "timeout" | "canceled" | "payload";

/** Internal error carrying the failure class so run() can word the guidance. */
class SandboxCallError extends Error {
  constructor(
    message: string,
    readonly kind: CallFailureKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SandboxCallError";
  }
}

interface CreateResponse {
  executionId?: unknown;
  id?: unknown;
  state?: unknown;
}

interface ExecutionState {
  status?: unknown;
  exitCode?: unknown;
  stdoutPreview?: unknown;
  stderrPreview?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  errorCode?: unknown;
  artifacts?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Go wire error convention: {"detail": "..."} (APISIX HTML error pages fall back to the raw body). */
function detailOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; message?: unknown };
    const detail = asString(parsed.detail) ?? asString(parsed.message);
    if (detail) return detail;
  } catch {
    // non-JSON body: keep the raw text (truncated by the caller's guidance)
  }
  return raw.trim().slice(0, 300);
}

/** Map the control plane's artifact list onto the port's summary shape. */
function mapArtifacts(raw: unknown): CodeExecutionArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeExecutionArtifact[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const name = asString(record.name) ?? asString(record.path);
    if (!name) continue;
    const artifact: CodeExecutionArtifact = { name };
    const size = asNumber(record.size) ?? asNumber(record.sizeBytes);
    if (size !== undefined) artifact.sizeBytes = size;
    const sha256 = asString(record.sha256);
    if (sha256) artifact.sha256 = sha256;
    const url = asString(record.url);
    if (url) artifact.url = url;
    out.push(artifact);
  }
  return out;
}

/** Human reason for a non-succeeded terminal state. */
function statusReason(status: string, errorCode: string | undefined): string {
  const code = errorCode ? ` [${errorCode}]` : "";
  switch (status) {
    case "timed_out":
    case "timedout":
    case "timeout":
      return "沙箱执行超时（timed_out）" + code;
    case "canceled":
    case "cancelled":
      return "沙箱执行已取消（canceled）" + code;
    case "failed":
      return "沙箱执行失败（failed）" + code;
    default:
      return `沙箱返回未成功状态（${status}）` + code;
  }
}

export class HttpCodeExecution implements CodeExecutionPort, CodeFilePort, CodeOutputPort, CodeInfoPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: SandboxFetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly extendForRequestTimeout: boolean;
  private readonly adaptivePolling: boolean;

  constructor(options: HttpCodeExecutionOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000;
    this.pollIntervalMs =
      Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
        ? Math.max(10, Math.floor(options.pollIntervalMs))
        : 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.nowImpl = options.nowImpl ?? Date.now;
    this.extendForRequestTimeout = options.extendForRequestTimeout === true;
    this.adaptivePolling = options.adaptivePolling === true;
  }

  /**
   * Create the execution and poll until a terminal state or the local deadline.
   * Resolves in every case; a failure is `sandboxAvailable=false` + Chinese error.
   */
  async run(request: CodeExecutionRequest, signal?: AbortSignal): Promise<CodeExecutionResult> {
    if (!request.code || request.code.trim() === "") {
      return this.unavailable("没有可执行的代码（code 为空）");
    }
    // The sandbox default budget is 120s; when the caller omits timeoutMs, do not
    // cut the local wait at 60s before the remote run can finish. Explicit
    // timeouts get a small HTTP/polling margin.
    const requested = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 120_000;
    const localBudget = this.extendForRequestTimeout
      ? Math.min(Math.max(this.timeoutMs, requested + 15_000), 620_000)
      : this.timeoutMs;
    const deadline = this.nowImpl() + localBudget;

    // 1) Create the execution. The per-call timeoutMs is the sandbox's own
    //    execution budget; this.timeoutMs bounds the whole local round-trip.
    let created: CreateResponse;
    try {
      const body: Record<string, unknown> = {
        language: request.language,
        code: request.code,
      };
      if (request.timeoutMs !== undefined) body.timeoutMs = request.timeoutMs;
      if (request.projectId) body.projectId = request.projectId;
      if (request.purpose) body.purpose = request.purpose;
      if (request.files && request.files.length > 0) body.files = request.files;
      if (request.artifactGlobs && request.artifactGlobs.length > 0) body.artifacts = request.artifactGlobs;
      created = asRecord(
        await this.call(
          "POST",
          "/v1/executions",
          body,
          request.uid,
          deadline - this.nowImpl(),
          signal,
          { "Idempotency-Key": randomUUID() },
        ),
      ) as CreateResponse;
    } catch (error) {
      return this.failure(error);
    }

    const executionId = asString(created.executionId) ?? asString(created.id);
    if (!executionId) {
      return this.unavailable("代码沙箱未返回 execution id（响应缺少 executionId）");
    }

    // 2) Poll until terminal or the deadline. Unknown non-terminal states keep
    //    polling: the control plane owns the state machine (creating→ready→busy…).
    //    Production backs off (500ms → 3s) so a long run does not hammer the DB.
    let pollDelay = this.pollIntervalMs;
    while (true) {
      if (signal?.aborted) {
        await this.cancelRemote(executionId, request.uid);
        return this.unavailable(`代码执行已取消（execution_id=${executionId}）`, executionId);
      }
      const remaining = deadline - this.nowImpl();
      if (remaining <= 0) break;

      let state: ExecutionState;
      try {
        state = asRecord(
          await this.call(
            "GET",
            `/v1/executions/${encodeURIComponent(executionId)}`,
            undefined,
            request.uid,
            remaining,
            signal,
          ),
        ) as ExecutionState;
      } catch (error) {
        if (error instanceof SandboxCallError && (error.kind === "timeout" || error.kind === "canceled")) {
          await this.cancelRemote(executionId, request.uid);
        }
        return this.failure(error, executionId);
      }

      const status = (asString(state.status) ?? "").toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        return this.fromTerminalState(executionId, status, state);
      }

      const afterPoll = deadline - this.nowImpl();
      if (afterPoll <= 0) break;
      await this.sleepImpl(Math.min(pollDelay, afterPoll));
      if (this.adaptivePolling) {
        pollDelay = Math.min(Math.round(pollDelay * 1.5), 3000);
      }
    }

    await this.cancelRemote(executionId, request.uid);
    log.warn("[SANDBOX] execution poll timed out execution_id=%s timeout_ms=%d", executionId, localBudget);
    return this.unavailable(
      `代码沙箱执行超时：${localBudget}ms 内未完成，已请求取消（execution_id=${executionId}）`,
      executionId,
    );
  }

  /** Read one file slice; throws on transport/server errors (tools render them). */
  async readFile(request: SandboxFileReadRequest, signal?: AbortSignal): Promise<SandboxFileReadResult> {
    const query = new URLSearchParams({ path: request.path });
    if (request.offset !== undefined) query.set("offset", String(request.offset));
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    if (request.projectId) query.set("projectId", request.projectId);
    if (request.purpose) query.set("purpose", request.purpose);
    const raw = await this.call(
      "GET",
      "/v1/files/read?" + query.toString(),
      undefined,
      request.uid,
      Math.max(this.timeoutMs, 30_000),
      signal,
    );
    const record = asRecord(raw);
    const hasMore = record.hasMore === true;
    const offset = asNumber(record.offset) ?? 0;
    const bytes = asNumber(record.bytes) ?? 0;
    const nextOffset = asNumber(record.nextOffset) ?? offset + bytes;
    return {
      path: asString(record.path) ?? request.path,
      content: typeof record.content === "string" ? record.content : "",
      offset,
      bytes,
      totalBytes: asNumber(record.totalBytes) ?? bytes,
      hasMore,
      nextOffset,
    };
  }

  /** Write (replace) one text file; throws on transport/server errors. */
  async writeFile(request: SandboxFileWriteRequest, signal?: AbortSignal): Promise<SandboxFileWriteResult> {
    const body: Record<string, unknown> = { path: request.path, content: request.content };
    if (request.encoding) body.encoding = request.encoding;
    if (request.projectId) body.projectId = request.projectId;
    if (request.purpose) body.purpose = request.purpose;
    const raw = await this.call("POST", "/v1/files/write", body, request.uid, Math.max(this.timeoutMs, 30_000), signal);
    const record = asRecord(raw);
    return {
      path: asString(record.path) ?? request.path,
      bytes: asNumber(record.bytes) ?? Buffer.byteLength(request.content, "utf8"),
    };
  }

  /** Read one page of a stored artifact (text utf8 / binary base64). */
  async readArtifact(request: SandboxArtifactReadRequest, signal?: AbortSignal): Promise<SandboxArtifactReadResult> {
    const query = new URLSearchParams({ name: request.name });
    if (request.offset !== undefined) query.set("offset", String(request.offset));
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    const raw = await this.call(
      "GET",
      "/v1/executions/" + encodeURIComponent(request.executionId) + "/artifacts/read?" + query.toString(),
      undefined,
      request.uid,
      Math.max(this.timeoutMs, 30_000),
      signal,
    );
    const record = asRecord(raw);
    const offset = asNumber(record.offset) ?? 0;
    const bytes = asNumber(record.bytes) ?? 0;
    return {
      executionId: asString(record.executionId) ?? request.executionId,
      name: asString(record.name) ?? request.name,
      contentType: asString(record.contentType) ?? "",
      encoding: record.encoding === "base64" ? "base64" : "utf8",
      binary: record.binary === true,
      content: typeof record.content === "string" ? record.content : "",
      offset,
      bytes,
      totalBytes: asNumber(record.totalBytes) ?? bytes,
      hasMore: record.hasMore === true,
      nextOffset: asNumber(record.nextOffset) ?? offset + bytes,
    };
  }

  /** Read the static sandbox runtime contract (image, limits, egress). */
  async getInfo(signal?: AbortSignal): Promise<SandboxRuntimeInfo> {
    const raw = await this.call("GET", "/v1/runtime", undefined, undefined, 10_000, signal);
    const record = asRecord(raw);
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      runtime: asString(record.runtime) ?? "",
      image: asString(record.image) ?? "",
      cpu: asString(record.cpu) ?? "",
      memory: asString(record.memory) ?? "",
      networkDefaultAction: asString(record.networkDefaultAction) ?? "unknown",
      egressAllow: strings(record.egressAllow),
      acceptedLanguages: strings(record.acceptedLanguages),
      notes: strings(record.notes),
    };
  }

  /** Read one page of a terminal execution's full stdout/stderr. */
  async readOutput(request: SandboxOutputRequest, signal?: AbortSignal): Promise<SandboxOutputResult> {
    const query = new URLSearchParams({ stream: request.stream ?? "stdout" });
    if (request.offset !== undefined) query.set("offset", String(request.offset));
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    const raw = await this.call(
      "GET",
      "/v1/executions/" + encodeURIComponent(request.executionId) + "/output?" + query.toString(),
      undefined,
      request.uid,
      Math.max(this.timeoutMs, 30_000),
      signal,
    );
    const record = asRecord(raw);
    const hasMore = record.hasMore === true;
    const offset = asNumber(record.offset) ?? 0;
    const bytes = asNumber(record.bytes) ?? 0;
    return {
      executionId: asString(record.executionId) ?? request.executionId,
      stream: record.stream === "stderr" ? "stderr" : "stdout",
      content: typeof record.content === "string" ? record.content : "",
      offset,
      bytes,
      totalBytes: asNumber(record.totalBytes) ?? bytes,
      sourceBytes: asNumber(record.sourceBytes) ?? bytes,
      truncated: record.truncated === true,
      hasMore,
      nextOffset: asNumber(record.nextOffset) ?? offset + bytes,
    };
  }

  /** Map a terminal control-plane state onto the port result. */
  private fromTerminalState(
    executionId: string,
    status: string,
    state: ExecutionState,
  ): CodeExecutionResult {
    const stdout = asString(state.stdoutPreview) ?? asString(state.stdout) ?? "";
    const stderr = asString(state.stderrPreview) ?? asString(state.stderr) ?? "";
    const exitCode = asNumber(state.exitCode);
    const artifacts = mapArtifacts(state.artifacts);
    // "succeeded" already means the sandbox process finished normally; a missing
    // exitCode is treated as 0 (a reported non-zero code is a failed run).
    const ok = status === "succeeded" && (exitCode === undefined || exitCode === 0);

    const result: CodeExecutionResult = {
      ok,
      stdout,
      stderr,
      sandboxAvailable: true,
      executionId,
    };
    const stdoutBytes = asNumber((state as Record<string, unknown>).stdoutBytes);
    const stderrBytes = asNumber((state as Record<string, unknown>).stderrBytes);
    if (stdoutBytes !== undefined) {
      result.stdoutBytes = stdoutBytes;
      result.stdoutTruncated = stdoutBytes > Buffer.byteLength(stdout, "utf8");
    }
    if (stderrBytes !== undefined) {
      result.stderrBytes = stderrBytes;
      result.stderrTruncated = stderrBytes > Buffer.byteLength(stderr, "utf8");
    }
    if (exitCode !== undefined) result.exitCode = exitCode;
    if (artifacts.length > 0) result.artifacts = artifacts;
    const durationMs = asNumber((state as Record<string, unknown>).durationMs);
    if (durationMs !== undefined) result.durationMs = durationMs;
    if (!ok) result.error = statusReason(status, asString(state.errorCode));
    return result;
  }

  /** Build the honest "not executed" result. */
  private unavailable(error: string, executionId?: string): CodeExecutionResult {
    const result: CodeExecutionResult = {
      ok: false,
      stdout: "",
      stderr: error,
      sandboxAvailable: false,
      error,
    };
    if (executionId) result.executionId = executionId;
    return result;
  }

  /** Translate a call failure into the port's non-throwing result. */
  private failure(error: unknown, executionId?: string): CodeExecutionResult {
    const suffix = executionId ? `（execution_id=${executionId}）` : "";
    if (error instanceof SandboxCallError) {
      switch (error.kind) {
        case "canceled":
          return this.unavailable(`代码执行已取消${suffix}`, executionId);
        case "timeout":
          return this.unavailable(
            `代码沙箱执行超时：${this.timeoutMs}ms 内未完成${suffix}`,
            executionId,
          );
        case "http":
          // 503 from the gateway is the classic "sandbox profile not started":
          // the upstream (app-sandbox / opensandbox-server) has no healthy endpoint.
          if (error.status === 503) {
            return this.unavailable(
              `代码沙箱服务暂不可用（HTTP 503）：app-sandbox 控制面未启动或网关上游不可达。` +
                `请在服务器执行 docker compose --profile sandbox up -d（或 --profile full），` +
                `并确认 app-sandbox 与 opensandbox-server 健康后再试${suffix}`,
              executionId,
            );
          }
          return this.unavailable(
            `代码沙箱返回错误（HTTP ${error.status ?? "?"}）：${error.message}${suffix}`,
            executionId,
          );
        case "payload":
          return this.unavailable(`代码沙箱响应无法解析：${error.message}${suffix}`, executionId);
        default:
          return this.unavailable(
            `代码沙箱连接失败：${error.message}（app-sandbox 未部署或不可达）${suffix}`,
            executionId,
          );
      }
    }
    return this.unavailable(`代码沙箱调用失败：${errorText(error)}${suffix}`, executionId);
  }

  /** Best-effort remote cancel so a local timeout does not leave the sandbox busy. */
  private async cancelRemote(executionId: string, uid: string | undefined): Promise<void> {
    try {
      await this.call(
        "POST",
        "/v1/executions/" + encodeURIComponent(executionId) + "/cancel",
        undefined,
        uid,
        5_000,
      );
    } catch (error) {
      log.warn("[SANDBOX] remote cancel failed execution_id=%s err=%s", executionId, errorText(error));
    }
  }

  /** Headers for both the gateway (apikey) and app-sandbox (X-API-Key + X-Uid). */
  private headers(uid: string | undefined, withBody: boolean): Record<string, string> {
    return {
      // APISIX key-auth consumer reads the lowercase "apikey" header; app-sandbox
      // additionally self-authenticates the same shared key via X-API-Key
      // uid rides X-Uid for quota/lease/audit scoping.
      ...(this.apiKey ? { apikey: this.apiKey, "X-API-Key": this.apiKey } : {}),
      ...(uid ? { "X-Uid": uid } : {}),
      ...(withBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  /**
   * One HTTP call bounded by `budgetMs` and the caller's abort signal. Throws a
   * classified SandboxCallError; never leaves a dangling timer.
   */
  private async call(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    uid: string | undefined,
    budgetMs: number,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new SandboxCallError("请求已取消", "canceled");
      signal.addEventListener("abort", onOuterAbort);
    }
    const budget = Math.max(1, Math.floor(budgetMs));
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budget);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this.headers(uid, body !== undefined), ...(extraHeaders ?? {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new SandboxCallError(detailOf(text) || `HTTP ${response.status}`, "http", response.status);
      }
      if (text === "") return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SandboxCallError("响应不是合法 JSON", "payload");
      }
    } catch (error) {
      if (error instanceof SandboxCallError) throw error;
      if (timedOut) throw new SandboxCallError(`请求超过 ${budget}ms`, "timeout");
      if (signal?.aborted) throw new SandboxCallError("请求已取消", "canceled");
      throw new SandboxCallError(errorText(error), "network");
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}
