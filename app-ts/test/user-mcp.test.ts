import { describe, expect, it } from "vitest";
import { UserMcpBridge, UserMcpError, type UserMcpSettingsPort } from "../src/mcp/user-connections.js";
import type { McpServerRecord } from "../src/clients/app-user-settings-mcp-client.js";

function fakePort(servers: McpServerRecord[], enabled = true): UserMcpSettingsPort & { wrote: boolean } {
  return {
    wrote: false,
    async servers() {
      return { enabled, servers };
    },
    async recordDiscovery() {
      this.wrote = true;
    },
    async refreshToken() {
      throw new Error("no oauth in fake");
    },
  };
}

const server = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 1,
  name: "github",
  url: "https://mcp.example.com/mcp",
  auth_kind: "bearer",
  api_key: "ghp_secret",
  enabled: true,
  tools: [{ name: "search_repositories", description: "Search repos" }],
  ...over,
});

describe("UserMcpBridge.catalog", () => {
  it("renders enabled servers with discovered tools", async () => {
    const svc = new UserMcpBridge(fakePort([server()]));
    const text = await svc.catalog("1");
    expect(text).toContain("MCP server github");
    expect(text).toContain("search_repositories");
    expect(text).toContain("mcp_user_call");
  });

  it("skips disabled servers and never leaks the API key", async () => {
    const svc = new UserMcpBridge(fakePort([server({ enabled: false })]));
    expect(await svc.catalog("1")).toBe("");

    const enabled = await new UserMcpBridge(fakePort([server()])).catalog("1");
    expect(enabled).not.toContain("ghp_secret");
  });

  it("degrades to an empty catalog when the settings service is down", async () => {
    const down: UserMcpSettingsPort = {
      async servers() {
        throw new Error("connection refused");
      },
      async recordDiscovery() {},
      async refreshToken() {
        throw new Error("down");
      },
    };
    await expect(new UserMcpBridge(down).catalog("1")).resolves.toBe("");
  });
});

describe("UserMcpBridge calls", () => {
  it("rejects an unknown server with 404 before touching the network", async () => {
    const svc = new UserMcpBridge(fakePort([]));
    await expect(svc.call("1", "nope", "x", {})).rejects.toBeInstanceOf(UserMcpError);
    await expect(svc.call("1", "nope", "x", {})).rejects.toMatchObject({ status: 404 });
  });

  it("rejects discovery for an unknown id", async () => {
    const svc = new UserMcpBridge(fakePort([]));
    await expect(svc.discover("1", 99)).rejects.toMatchObject({ status: 404 });
  });

  it("surfaces a settings-service outage as 502", async () => {
    const down: UserMcpSettingsPort = {
      async servers() {
        throw new Error("timeout");
      },
      async recordDiscovery() {},
      async refreshToken() {
        throw new Error("down");
      },
    };
    await expect(new UserMcpBridge(down).discover("1", 1)).rejects.toMatchObject({ status: 502 });
  });
});
