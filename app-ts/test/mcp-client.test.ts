import { describe, it, expect } from "vitest";
import { McpClient, mcpClientStats } from "../src/mcp/client.js";

/**
 * McpClient facade over the official MCP SDK, exercised with an injected fake
 * fetch implementing the streamable-http server side: GET → 405 (no standalone
 * SSE), initialize handshake (protocol version echoed), 202 for the
 * initialized notification, id-echoing JSON replies, DELETE for teardown.
 * The unreachable-endpoint case lives in quiz-board.test.ts.
 */

interface FakeCall {
  url: string;
  init: RequestInit;
  body: { method?: string; id?: number; params?: Record<string, unknown> };
}

function makeFetch(handler: (call: FakeCall) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    let body: FakeCall["body"] = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      body = {};
    }
    const call: FakeCall = { url: String(url), init: init ?? {}, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonRpc(id: number, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const TOOL_SCHEMA = { type: "object", properties: {} };

function standardServer(overrides?: (call: FakeCall) => Response | undefined) {
  return makeFetch((call) => {
    const viaOverride = overrides?.(call);
    if (viaOverride) return viaOverride;
    if (call.init.method === "GET") return new Response(null, { status: 405 }); // no standalone SSE
    if (call.init.method === "DELETE") return new Response(null, { status: 200 });
    switch (call.body.method) {
      case "initialize":
        return jsonRpc(
          call.body.id ?? 1,
          {
            protocolVersion: call.body.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "app-board-mcp", version: "1.0.0" },
          },
          { "mcp-session-id": "sess-abc" },
        );
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/call":
        return jsonRpc(call.body.id ?? 0, { content: [{ type: "text", text: "board-data" }] });
      case "tools/list":
        return jsonRpc(call.body.id ?? 0, {
          tools: [
            { name: "list_boards", description: "list", inputSchema: TOOL_SCHEMA },
            { name: "get_board", inputSchema: TOOL_SCHEMA },
          ],
          nextCursor: "cur-9",
        });
      case "ping":
        return jsonRpc(call.body.id ?? 0, {});
      default:
        return new Response(null, { status: 404 });
    }
  });
}

const posts = (calls: FakeCall[]) =>
  calls.filter((c) => c.init.method === "POST").map((c) => c.body.method);
/** SDK passes Headers instances to fetch — normalize before property access. */
const hdrs = (call: FakeCall): Record<string, string> => {
  const h = call.init.headers as Headers | Record<string, string> | undefined;
  if (h && typeof (h as Headers).forEach === "function") {
    const out: Record<string, string> = {};
    (h as Headers).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return (h ?? {}) as Record<string, string>;
};

describe("McpClient short-session facade", () => {
  it("callTool: handshake → tools/call → DELETE, session id + uid + auth headers carried", async () => {
    const { impl, calls } = standardServer();
    const client = new McpClient({
      url: "http://mcp.test/mcp",
      timeoutMs: 5000,
      defaultHeaders: { "X-Api-Key": "k-1" },
      fetchImpl: impl,
    });

    const res = await client.callTool("get_board", { uuid: "u1" }, { uid: 42 });

    expect(res).toMatchObject({ ok: true, content: "board-data" });
    expect(posts(calls)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(calls.some((c) => c.init.method === "GET")).toBe(true); // standalone SSE attempted, 405 tolerated
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(true); // session terminated
    const call = calls.find((c) => c.body.method === "tools/call")!;
    expect(hdrs(call)["mcp-session-id"]).toBe("sess-abc");
    expect(hdrs(call)["x-uid"]).toBe("42"); // Headers keys normalize to lowercase
    expect(hdrs(call)["x-api-key"]).toBe("k-1");
    // identity never enters the tool arguments (§2.12 red line)
    expect(call.body.params).toEqual({ name: "get_board", arguments: { uuid: "u1" } });
  });

  it("each call opens a fresh short session (two handshakes, two DELETEs)", async () => {
    const { impl, calls } = standardServer();
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    await client.callTool("list_boards", {}, {});
    await client.callTool("list_boards", {}, {});
    expect(calls.filter((c) => c.body.method === "initialize")).toHaveLength(2);
    expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(2);
  });

  it("empty url → explicit config error, no requests", async () => {
    const { impl, calls } = standardServer();
    const client = new McpClient({ url: "", fetchImpl: impl });
    const res = await client.callTool("list_boards", {}, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("MCP 端点未配置");
    expect(calls).toHaveLength(0);
  });

  it("listTools returns parsed tools + cursor; cursor param is passed through", async () => {
    const { impl, calls } = standardServer();
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.listTools({ uid: 7 });
    expect(res.ok).toBe(true);
    expect(res.tools.map((t) => t.name)).toEqual(["list_boards", "get_board"]);
    expect(res.nextCursor).toBe("cur-9");

    await client.listTools({ cursor: "cur-9" });
    const listCall = calls.filter((c) => c.body.method === "tools/list").at(-1)!;
    expect(listCall.body.params).toEqual({ cursor: "cur-9" });
  });

  it("ping round-trips through a full session", async () => {
    const { impl } = standardServer();
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.ping({ uid: 1 });
    expect(res.ok).toBe(true);
  });

  it("no session id assigned → call succeeds and no DELETE is sent", async () => {
    const { impl, calls } = standardServer((call) => {
      if (call.body.method === "initialize") {
        return jsonRpc(call.body.id ?? 1, {
          protocolVersion: call.body.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "s", version: "1" },
        });
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("list_boards", {}, {});
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(0);
  });
});

describe("McpClient error mapping (never throws)", () => {
  it("server JSON-RPC error on tools/call surfaces the server message", async () => {
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: call.body.id, error: { code: -32000, message: "board not found" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", { uuid: "u1" }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("board not found");
  });

  it("server JSON-RPC error on initialize fails before the business request", async () => {
    const { impl, calls } = standardServer((call) => {
      if (call.body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: call.body.id, error: { code: -32601, message: "version rejected" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("version rejected");
    expect(posts(calls)).toEqual(["initialize"]);
  });

  it("isError tool result → ok:false with the tool's own text", async () => {
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") {
        return jsonRpc(call.body.id ?? 0, { content: [{ type: "text", text: "uuid 不存在" }], isError: true });
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(false);
    expect(res.content).toBe("uuid 不存在");
    expect(res.error).toBe("uuid 不存在");
  });

  it("structuredContent is passed through on success", async () => {
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") {
        return jsonRpc(call.body.id ?? 0, {
          content: [{ type: "text", text: "x" }],
          structuredContent: { version: 3 },
        });
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(true);
    expect(res.structuredContent).toEqual({ version: 3 });
  });

  it("HTTP 500 → prefixed transport error with status", async () => {
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") return new Response("boom", { status: 500 });
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("MCP 调用失败");
    // SDK's StreamableHTTPError message names the failed POST (status rides err.code)
    expect(res.error).toContain("Error POSTing to endpoint");
  });

  it("network-level failure (fetch rejects) → prefixed transport error", async () => {
    const { impl } = makeFetch(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:8005");
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("MCP 调用失败");
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("per-request timeout → SDK McpError surfaced verbatim", async () => {
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") return new Promise<Response>(() => {}); // hang
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", timeoutMs: 60, fetchImpl: impl });
    const res = await client.callTool("get_board", {}, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Request timed out");
  });
});

describe("cancellation (TimeoutManager / user stop)", () => {
  it("pre-aborted signal → friendly cancellation error, business request never sent", async () => {
    const { impl, calls } = standardServer();
    const client = new McpClient({ url: "http://mcp.test/mcp", fetchImpl: impl });
    const controller = new AbortController();
    controller.abort();

    const res = await client.callTool("get_board", {}, { uid: 1, signal: controller.signal });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("MCP 调用已取消");
    expect(res.errorKind).toBe("transport");
    expect(calls.some((c) => c.body.method === "tools/call")).toBe(false);
  });

  it("mid-call abort → in-flight request aborted, session still torn down", async () => {
    const { impl, calls } = standardServer((call) => {
      if (call.body.method === "tools/call") {
        return new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        });
      }
      return undefined;
    });
    const client = new McpClient({ url: "http://mcp.test/mcp", timeoutMs: 5000, fetchImpl: impl });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const res = await client.callTool("get_board", {}, { uid: 1, signal: controller.signal });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("MCP 调用已取消");
    // teardown runs even on the cancelled path (session GC'd server-side)
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
  });
});

describe("mcpClientStats", () => {
  it("per-instance counters accumulate across ok / tool_error / transport-failed calls", async () => {
    let mode: "ok" | "isError" | "http500" = "ok";
    const { impl } = standardServer((call) => {
      if (call.body.method === "tools/call") {
        if (mode === "isError") {
          return jsonRpc(call.body.id ?? 0, { content: [{ type: "text", text: "bad uuid" }], isError: true });
        }
        if (mode === "http500") return new Response("boom", { status: 500 });
      }
      return undefined;
    });
    const client = new McpClient({ name: "stats-probe", url: "http://mcp.test/mcp", fetchImpl: impl });

    await client.callTool("list_boards", {}, {});
    mode = "isError";
    await client.callTool("get_board", {}, {});
    mode = "http500";
    await client.callTool("get_board", {}, {});

    const stat = mcpClientStats().find((s) => s.name === "stats-probe")!;
    expect(stat.calls).toBe(3);
    expect(stat.ok).toBe(1);
    expect(stat.toolErrors).toBe(1);
    expect(stat.failed).toBe(1);
    expect(stat.lastError).toContain("Error POSTing to endpoint");
    expect(stat.lastCallAt).toBeDefined();
  });
});
