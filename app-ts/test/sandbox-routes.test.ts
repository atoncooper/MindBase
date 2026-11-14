import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { registerSandboxRoutes } from "../src/transport/http/routes/sandbox.js";

/**
 * Route-level tests for the sandbox control-plane proxy
 * (docs/research-ui-api.md §7). The upstream is a fake fetch, so nothing
 * leaves the process: enabled/disabled answers, header forwarding, detail
 * passthrough and the 503 failure policy are all exercised offline.
 */

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function buildApp(options: { enabled?: boolean; baseUrl?: string; response?: () => Promise<Response> | Response } = {}) {
  const calls: CapturedCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (options.response) return options.response();
    return new Response(JSON.stringify({ executions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerSandboxRoutes(app, {
    enabled: options.enabled ?? true,
    baseUrl: options.baseUrl ?? "http://apisix:9080/internal/sandbox/v1",
    apiKey: "test-key",
    timeoutMs: 1000,
    fetchImpl,
  });
  return { app, calls };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });
/** POST routes without a request body must not claim JSON content. */
const uidOnly = (uid: string) => ({ "x-uid": uid });

describe("sandbox routes", () => {
  it("requires the gateway uid", async () => {
    const { app, calls } = buildApp();
    const res = await app.inject({ method: "GET", url: "/chat/sandbox/executions" });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("answers the honest disabled shape and 503 for detail/cancel", async () => {
    const { app, calls } = buildApp({ enabled: false });
    const list = await app.inject({ method: "GET", url: "/chat/sandbox/executions", headers: asUid("1") });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ enabled: false, executions: [] });

    const detail = await app.inject({ method: "GET", url: "/chat/sandbox/executions/e1", headers: asUid("1") });
    expect(detail.statusCode).toBe(503);
    expect(detail.json().detail).toBe("沙箱服务暂不可用");

    const cancel = await app.inject({ method: "POST", url: "/chat/sandbox/executions/e1/cancel", headers: uidOnly("1") });
    expect(cancel.statusCode).toBe(503);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("proxies the execution list with gateway + sandbox headers", async () => {
    const payload = [
      {
        executionId: "e1",
        leaseId: "l1",
        language: "python",
        status: "succeeded",
        timeoutMs: 5000,
        createdAt: 1,
        done: true,
        artifacts: [{ name: "out.txt", size: 3, url: "http://minio/out.txt" }],
      },
    ];
    const { app, calls } = buildApp({
      response: () => new Response(JSON.stringify({ executions: payload }), { status: 200 }),
    });
    const res = await app.inject({ method: "GET", url: "/chat/sandbox/executions?limit=30", headers: asUid("42") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, executions: payload });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://apisix:9080/internal/sandbox/v1/executions?limit=30");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.apikey).toBe("test-key");
    expect(calls[0].headers["X-API-Key"]).toBe("test-key");
    expect(calls[0].headers["X-Uid"]).toBe("42");
    await app.close();
  });

  it("uses an unversioned base URL by appending /v1", async () => {
    const { app, calls } = buildApp({ baseUrl: "http://apisix:9080/internal/sandbox" });
    await app.inject({ method: "GET", url: "/chat/sandbox/executions", headers: asUid("1") });
    expect(calls[0].url).toBe("http://apisix:9080/internal/sandbox/v1/executions?limit=20");
    await app.close();
  });

  it("proxies execution detail and cancel", async () => {
    const execution = { executionId: "e1", status: "running", done: false };
    const { app, calls } = buildApp({
      response: () => new Response(JSON.stringify(execution), { status: 200 }),
    });
    const detail = await app.inject({ method: "GET", url: "/chat/sandbox/executions/e1", headers: asUid("7") });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ execution });

    const cancel = await app.inject({ method: "POST", url: "/chat/sandbox/executions/e1/cancel", headers: uidOnly("7") });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1].url).toBe("http://apisix:9080/internal/sandbox/v1/executions/e1/cancel");
    await app.close();
  });

  it("passes an upstream 404 detail through", async () => {
    const { app } = buildApp({
      response: () =>
        new Response(JSON.stringify({ detail: "执行不存在或无权访问" }), { status: 404 }),
    });
    const detail = await app.inject({ method: "GET", url: "/chat/sandbox/executions/e1", headers: asUid("1") });
    expect(detail.statusCode).toBe(404);
    expect(detail.json().detail).toBe("执行不存在或无权访问");

    const cancel = await app.inject({ method: "POST", url: "/chat/sandbox/executions/e1/cancel", headers: uidOnly("1") });
    expect(cancel.statusCode).toBe(404);
    await app.close();
  });

  it("maps upstream failures onto 503", async () => {
    const unreachable = buildApp({ response: () => Promise.reject(new Error("ECONNREFUSED")) });
    const res = await unreachable.app.inject({
      method: "GET",
      url: "/chat/sandbox/executions",
      headers: asUid("1"),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toBe("沙箱服务暂不可用");
    await unreachable.app.close();

    const serverError = buildApp({ response: () => new Response("boom", { status: 500 }) });
    const upstream500 = await serverError.app.inject({
      method: "GET",
      url: "/chat/sandbox/executions",
      headers: asUid("1"),
    });
    expect(upstream500.statusCode).toBe(503);
    expect(upstream500.json().detail).toBe("沙箱服务暂不可用");
    await serverError.app.close();
  });
});