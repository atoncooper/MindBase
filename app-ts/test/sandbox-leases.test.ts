import { describe, expect, it } from "vitest";
import { SandboxLeaseReleaser } from "../src/services/research/sandbox-leases.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SandboxLeaseReleaser", () => {
  it("calls the project lease endpoint with M2M headers and returns released count", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const client = new SandboxLeaseReleaser({
      enabled: true,
      baseUrl: "https://apisix:9443/internal/sandbox/",
      apiKey: "k",
      fetchImpl: (async (input, options) => {
        url = String(input);
        init = options;
        return json({ released: 2, failed: [] });
      }) as typeof fetch,
    });
    const released = await client.releaseProject("42", "proj-1");
    expect(released).toBe(2);
    expect(url).toContain("/internal/sandbox/v1/leases?uid=42&projectId=proj-1");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Record<string, string>)["X-UID"]).toBeUndefined();
    expect((init?.headers as Record<string, string>)["X-Uid"]).toBe("42");
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("k");
  });

  it("stays best-effort: disabled, non-2xx and network errors return 0", async () => {
    const disabled = new SandboxLeaseReleaser({
      enabled: false,
      baseUrl: "https://x",
      apiKey: "k",
      fetchImpl: (async () => json({ released: 9 })) as typeof fetch,
    });
    expect(await disabled.releaseProject("1", "p")).toBe(0);

    const failing = new SandboxLeaseReleaser({
      enabled: true,
      baseUrl: "https://x",
      apiKey: "k",
      fetchImpl: (async () => json({ detail: "no" }, 500)) as typeof fetch,
    });
    expect(await failing.releaseProject("1", "p")).toBe(0);

    const broken = new SandboxLeaseReleaser({
      enabled: true,
      baseUrl: "https://x",
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("network");
      }) as typeof fetch,
    });
    expect(await broken.releaseProject("1", "p")).toBe(0);
  });
});
