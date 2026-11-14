import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";

/**
 * /chat/sandbox/* — read-only proxy for the app-sandbox control plane
 * (docs/research-ui-api.md §7).
 *
 * The sandbox is an internal M2M service: the browser never talks to it
 * directly. app-ts forwards with the gateway consumer key (apikey) plus the
 * sandbox's own auth/identity headers (X-API-Key + X-Uid), so a user can only
 * ever list/cancel their own executions.
 *
 * Failure policy:
 *  - sandbox disabled (config.sandbox.enabled=false): lists answer
 *    200 { enabled:false, executions:[] }, detail/cancel answer 503;
 *  - upstream unreachable/timeout/non-404 error: 503 { detail:"沙箱服务暂不可用" };
 *  - upstream 404 is passed through with its { detail }.
 */

/** Minimal fetch shape (injectable; defaults to the global fetch). */
export type SandboxFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SandboxRouteDeps {
  /** config.sandbox.enabled — false = honest "panel disabled" answer */
  enabled: boolean;
  /** app-sandbox control-plane base URL (APISIX internal route, with or without /v1) */
  baseUrl: string;
  /** shared M2M key (apikey for APISIX + X-API-Key for app-sandbox) */
  apiKey: string;
  /** local deadline for one upstream call (ms); defaults to 10s */
  timeoutMs?: number;
  /** test seam; defaults to global fetch */
  fetchImpl?: SandboxFetch;
}

const UPSTREAM_UNAVAILABLE = "沙箱服务暂不可用";
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

type UpstreamResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; detail: string };

export function registerSandboxRoutes(app: FastifyInstance, deps: SandboxRouteDeps): void {
  const fetchImpl: SandboxFetch = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = deps.apiKey.trim();
  const timeoutMs =
    deps.timeoutMs !== undefined && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? Math.trunc(deps.timeoutMs)
      : DEFAULT_PROXY_TIMEOUT_MS;

  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" && /^\d+$/.test(uid) ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  /**
   * Upstream URL builder: the deployed default base URL is
   * ".../internal/sandbox" while the control plane is versioned (/v1/...);
   * an already-versioned base URL is used verbatim.
   */
  const upstreamUrl = (path: string): string => {
    if (baseUrl === "") return "";
    const versioned = /\/v1$/.test(baseUrl) ? baseUrl : baseUrl + "/v1";
    return versioned + path;
  };

  /** One upstream call bounded by the proxy deadline; never throws. */
  const call = async (method: string, path: string, uid: string): Promise<UpstreamResult> => {
    const url = upstreamUrl(path);
    if (url === "") return { ok: false, status: 503, detail: UPSTREAM_UNAVAILABLE };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          // APISIX key-auth consumer reads lowercase "apikey"; app-sandbox
          // self-authenticates the same shared key via X-API-Key.
          ...(apiKey ? { apikey: apiKey, "X-API-Key": apiKey } : {}),
          "X-Uid": uid,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, status: response.status, detail: detailOf(text) };
      }
      return { ok: true, body: parseRecord(text) };
    } catch {
      return { ok: false, status: 503, detail: UPSTREAM_UNAVAILABLE };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Map a failed upstream call onto the contract statuses. */
  const failure = (reply: FastifyReply, result: Extract<UpstreamResult, { ok: false }>): FastifyReply => {
    if (result.status === 404) {
      return reply.status(404).send({ detail: result.detail || "执行记录不存在或无权访问" });
    }
    return reply.status(503).send({ detail: UPSTREAM_UNAVAILABLE });
  };

  const disabled = (reply: FastifyReply): FastifyReply =>
    reply.status(503).send({ detail: UPSTREAM_UNAVAILABLE });

  // ---- list ---------------------------------------------------------------

  app.get("/chat/sandbox/executions", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.enabled) return { enabled: false, executions: [] };
    const limit = listLimit((req.query as { limit?: unknown }).limit);
    const result = await call("GET", "/executions?limit=" + limit, uid);
    if (!result.ok) return failure(reply, result);
    const executions = result.body.executions;
    if (!Array.isArray(executions)) return disabled(reply);
    // executionPayload fields are forwarded verbatim (contract §7).
    return { enabled: true, executions };
  });

  // ---- detail -------------------------------------------------------------

  app.get("/chat/sandbox/executions/:id", async (req: FastifyRequest, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.enabled) return disabled(reply);
    const { id } = req.params as { id: string };
    const result = await call("GET", "/executions/" + encodeURIComponent(id), uid);
    if (!result.ok) return failure(reply, result);
    return { execution: result.body };
  });

  // ---- cancel -------------------------------------------------------------

  app.post("/chat/sandbox/executions/:id/cancel", async (req: FastifyRequest, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.enabled) return disabled(reply);
    const { id } = req.params as { id: string };
    const result = await call("POST", "/executions/" + encodeURIComponent(id) + "/cancel", uid);
    if (!result.ok) return failure(reply, result);
    return { cancelled: true };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listLimit(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIST_LIMIT);
}

function parseRecord(text: string): Record<string, unknown> {
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Go wire error convention {"detail": "..."}; empty body falls back to a generic message. */
function detailOf(text: string): string {
  const parsed = parseRecord(text);
  if (typeof parsed.detail === "string" && parsed.detail.trim() !== "") return parsed.detail;
  if (typeof parsed.message === "string" && parsed.message.trim() !== "") return parsed.message;
  const raw = text.trim();
  return raw === "" ? UPSTREAM_UNAVAILABLE : raw.slice(0, 300);
}
