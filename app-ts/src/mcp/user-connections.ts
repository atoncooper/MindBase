// Per-user MCP bridge — MCP domain, not the settings domain.
//
// User MCP connections (URL + API key + discovered-tool cache) are stored and
// CRUD'd by app-user's settings domain (user_mcp_servers). This module is the
// agent-side bridge only: it reads those connections through the internal M2M
// face and performs MCP protocol work (SSRF guard, tools/list, tools/call) for
// the current turn's uid. It never persists anything.
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { McpClient, type McpCallResult, type McpToolInfo } from "../mcp/index.js";
import type { McpServerRecord } from "../clients/app-user-settings-mcp-client.js";

const log = createLogger("MCP");

export class UserMcpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Safe wire shape returned by the discovery endpoint (never carries the key). */
export interface UserMcpServerView {
  id: number;
  name: string;
  url: string;
  auth_kind: string;
  auth_header?: string;
  enabled: boolean;
  tools: Array<{ name: string; description?: string }>;
  last_error?: string;
}

/** The settings-domain port this service needs (app-user M2M in production). */
export interface UserMcpSettingsPort {
  servers(uid: string, opts?: { fresh?: boolean }): Promise<{ enabled: boolean; servers: McpServerRecord[] }>;
  recordDiscovery(uid: string, id: number, tools: McpToolInfo[], lastError: string): Promise<void>;
  refreshToken(uid: string, id: number): Promise<{ access_token: string; expires_at?: number }>;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
  }
  return false;
}

/** Map the stored credential (static key or OAuth token) to request headers. */
function authHeaders(
  server: Pick<McpServerRecord, "auth_kind" | "auth_header" | "api_key">,
  oauthToken?: string,
): Record<string, string> {
  if (server.auth_kind === "oauth") {
    return oauthToken ? { Authorization: "Bearer " + oauthToken } : {};
  }
  const key = server.api_key?.trim();
  if (!key) return {};
  if (server.auth_kind === "header" && server.auth_header) {
    return { [server.auth_header]: key };
  }
  return { Authorization: "Bearer " + key };
}

/**
 * Bridges a user's stored MCP connections into the agent tool surface.
 *
 * Storage/CRUD/credential encryption live in app-user's settings domain
 * (user_mcp_servers); this bridge owns only the MCP protocol: SSRF guard,
 * tools/list discovery and tools/call execution. uid is always supplied by the
 * caller (request context / ToolRunContext), never by the model.
 */
export class UserMcpBridge {
  constructor(private readonly client: UserMcpSettingsPort) {}

  /** Reject URLs that resolve to loopback/private/link-local targets (SSRF). */
  private async assertSafeUrl(raw: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new UserMcpError(400, "MCP URL 不合法");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new UserMcpError(400, "MCP 仅支持 http/https");
    }
    if (url.username || url.password) throw new UserMcpError(400, "MCP URL 不能包含用户名/密码");
    if (!config.userMcp.allowPrivateHosts) {
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "host.docker.internal" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        (net.isIP(host) && isPrivateAddress(host))
      ) {
        throw new UserMcpError(400, "默认禁止私网/localhost MCP 地址");
      }
      let addresses: Array<{ address: string }> = [];
      try {
        addresses = await dns.lookup(host, { all: true });
      } catch {
        throw new UserMcpError(400, "MCP 域名无法解析");
      }
      if (addresses.some((a) => isPrivateAddress(a.address))) {
        throw new UserMcpError(400, "MCP 域名解析到私网地址，已拒绝");
      }
    }
    return url.toString();
  }

  private async discoverTools(url: string, headers: Record<string, string>): Promise<McpToolInfo[]> {
    const client = new McpClient({
      name: "user-mcp",
      url,
      timeoutMs: config.userMcp.timeoutMs,
      defaultHeaders: headers,
    });
    const list = await client.listTools();
    if (!list.ok) throw new UserMcpError(502, list.error || "MCP tools/list 失败");
    return list.tools;
  }

  /** Read the user's connections; a settings-service outage is a clean 502. */
  private async connections(uid: string, fresh = false): Promise<{ enabled: boolean; servers: McpServerRecord[] }> {
    try {
      return await this.client.servers(uid, fresh ? { fresh: true } : undefined);
    } catch (err) {
      log.warn(`[MCP] app-user settings unavailable uid=${uid}: ${String(err)}`);
      throw new UserMcpError(502, "无法读取 MCP 配置，请稍后重试");
    }
  }

  /** Resolve a usable token, refreshing OAuth credentials shortly before expiry. */
  private async tokenFor(uid: string, server: McpServerRecord): Promise<string | undefined> {
    if (server.auth_kind !== "oauth") return undefined;
    if (!server.access_token) {
      // Local domain state, NOT a session failure: 409 keeps the frontend from
      // treating this as "登录过期" and clearing the user's session.
      throw new UserMcpError(409, "该连接尚未完成 OAuth 授权，请先在列表里点击「授权」");
    }
    const stale = server.expires_at !== undefined && server.expires_at - Date.now() < 60_000;
    if (!stale) return server.access_token;
    try {
      const refreshed = await this.client.refreshToken(uid, server.id);
      server.access_token = refreshed.access_token;
      if (refreshed.expires_at !== undefined) server.expires_at = refreshed.expires_at;
      return refreshed.access_token;
    } catch (err) {
      log.warn(`[MCP] token refresh failed uid=${uid} id=${server.id}: ${String(err)}`);
      throw new UserMcpError(409, "MCP 授权已过期，请点击「重新授权」");
    }
  }

  private view(server: McpServerRecord): UserMcpServerView {
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      auth_kind: server.auth_kind,
      ...(server.auth_header ? { auth_header: server.auth_header } : {}),
      enabled: server.enabled,
      tools: server.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
      ...(server.last_error ? { last_error: server.last_error } : {}),
    };
  }

  /**
   * Probe one connection: read it fresh from app-user, run tools/list and write
   * the result back (the settings page and the chat catalog both read it).
   */
  async discover(uid: string, id: number): Promise<UserMcpServerView> {
    const { enabled, servers } = await this.connections(uid, true);
    if (!enabled) throw new UserMcpError(503, "用户 MCP 功能未启用");
    const server = servers.find((s) => s.id === id);
    if (!server) throw new UserMcpError(404, "MCP server 不存在");
    try {
      const url = await this.assertSafeUrl(server.url);
      const token = await this.tokenFor(uid, server);
      const tools = await this.discoverTools(url, authHeaders(server, token));
      await this.client.recordDiscovery(uid, id, tools, "").catch((err) => {
        log.warn(`[MCP] discovery write-back failed uid=${uid} id=${id}: ${String(err)}`);
      });
      return this.view({ ...server, tools, last_error: "" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 409 = local "not authorized yet": not an upstream probe failure, so the
      // row keeps its previous discovery result instead of storing noise.
      if (!(err instanceof UserMcpError && err.status === 409)) {
        await this.client.recordDiscovery(uid, id, [], message).catch(() => undefined);
      }
      throw err instanceof UserMcpError ? err : new UserMcpError(502, message);
    }
  }

  /** Prompt section listing this user's enabled tools ("" = nothing to inject). */
  async catalog(uid: string): Promise<string> {
    let enabled = true;
    let servers: McpServerRecord[] = [];
    try {
      ({ enabled, servers } = await this.client.servers(uid));
    } catch (err) {
      // app-user down must never break the chat turn: degrade to no MCP tools.
      log.warn(`[MCP] catalog unavailable uid=${uid}: ${String(err)}`);
      return "";
    }
    if (!enabled) return "";
    const usable = servers.filter((s) => s.enabled && s.tools.length > 0);
    if (usable.length === 0) return "";
    const lines = ["# 用户的 MCP 工具", "当用户问题涉及以下第三方服务时，先调用下面的工具，不要假装知道结果："];
    for (const s of usable) {
      lines.push("");
      lines.push("MCP server " + s.name + "（" + s.url + "）：");
      for (const t of s.tools) {
        lines.push("- " + t.name + (t.description ? "：" + t.description.slice(0, 200) : ""));
      }
    }
    lines.push("");
    lines.push("调用方式：mcp_user_call({ server, tool, arguments })。");
    lines.push("server 和 tool 必须精确使用上面的名称；arguments 是 JSON 对象。");
    return lines.join(String.fromCharCode(10));
  }

  /** Execute one tool call against the user's own connection. */
  async call(
    uid: string,
    serverName: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    let { enabled, servers } = await this.connections(uid);
    if (!enabled) throw new UserMcpError(503, "用户 MCP 功能未启用");
    let server = servers.find((s) => s.name === serverName);
    if (!server) {
      // A connection created seconds ago may not be in the cached list yet.
      ({ servers } = await this.connections(uid, true));
      server = servers.find((s) => s.name === serverName);
    }
    if (!server || !server.enabled) throw new UserMcpError(404, "MCP server 不存在或未启用");
    const url = await this.assertSafeUrl(server.url);
    const token = await this.tokenFor(uid, server);
    const client = new McpClient({
      name: "user:" + server.name,
      url,
      timeoutMs: config.userMcp.timeoutMs,
      defaultHeaders: authHeaders(server, token),
    });
    return client.callTool(tool, args, { uid, signal });
  }
}
