import { config } from "../config/index.js";
import { InternalServiceClient } from "../transport/internal-client.js";

/**
 * Per-user MCP connections live in app-user's settings domain
 * (user_mcp_servers), not in app-ts: endpoints and API keys are user
 * configuration, the same ownership rule as Coding Plan. app-ts owns the MCP
 * protocol (tools/list + tools/call) and reads the decrypted list through this
 * internal M2M face.
 *
 * Contract (apikey-guarded):
 *   GET   /internal/settings/mcp/{uid}                    → {enabled, servers[]}
 *   PATCH /internal/settings/mcp/{uid}/{id}/discovery     → tools/list write-back
 */

export interface McpServerTool {
  name: string;
  description?: string;
}

/** Internal wire shape: carries the decrypted api_key, never sent to the UI. */
export interface McpServerRecord {
  id: number;
  name: string;
  url: string;
  auth_kind: "none" | "bearer" | "header" | string;
  auth_header?: string;
  api_key?: string;
  enabled: boolean;
  tools: McpServerTool[];
  last_error?: string;
  /** OAuth 2.1 (auth_kind=oauth): a token is stored for this connection. */
  oauth_authorized?: boolean;
  access_token?: string;
  /** Access-token expiry, unix ms. */
  expires_at?: number;
}

export class AppUserSettingsMcpClient extends InternalServiceClient {
  /** uid → connections; short TTL so edits appear without a per-turn M2M call. */
  private readonly cache = new Map<string, { at: number; enabled: boolean; servers: McpServerRecord[] }>();

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appUserSettings.baseUrl,
        apiKey: opts?.apiKey ?? config.appUserSettings.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appUserSettings.timeoutMs,
      },
      "app-user-settings",
    );
  }

  /** List the user's connections. fresh=true bypasses the cache (discovery). */
  async servers(uid: string, opts?: { fresh?: boolean }): Promise<{ enabled: boolean; servers: McpServerRecord[] }> {
    const cached = this.cache.get(uid);
    if (!opts?.fresh && cached && Date.now() - cached.at < config.userMcp.cacheTtlMs) {
      return { enabled: cached.enabled, servers: cached.servers };
    }
    const res = await this.request("GET", `/internal/settings/mcp/${encodeURIComponent(uid)}`);
    const body = await this.json<{ enabled?: boolean; servers?: McpServerRecord[] }>(res, "app-user MCP lookup failed");
    const value = { enabled: body.enabled !== false, servers: body.servers ?? [] };
    this.cache.set(uid, { at: Date.now(), ...value });
    return value;
  }

  /** Write the tools/list result back so the settings page and the chat
   *  catalog see it without re-probing on every render. */
  async recordDiscovery(uid: string, id: number, tools: McpServerTool[], lastError: string): Promise<void> {
    const res = await this.request("PATCH", `/internal/settings/mcp/${encodeURIComponent(uid)}/${id}/discovery`, {
      tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
      last_error: lastError,
    });
    await this.json<unknown>(res, "app-user MCP discovery write-back failed");
    this.cache.delete(uid);
  }

  /** Rotate the OAuth access token via the settings service. */
  async refreshToken(uid: string, id: number): Promise<{ access_token: string; expires_at?: number }> {
    const res = await this.request(
      "POST",
      `/internal/settings/mcp/${encodeURIComponent(uid)}/${id}/refresh`,
    );
    const body = await this.json<{ access_token?: string; expires_at?: number }>(res, "app-user MCP token refresh failed");
    if (!body.access_token) throw new Error("app-user MCP refresh returned no access_token");
    this.cache.delete(uid);
    return { access_token: body.access_token, ...(body.expires_at ? { expires_at: body.expires_at } : {}) };
  }

  /** Drop the cached list (after a local edit). */
  invalidate(uid: string): void {
    this.cache.delete(uid);
  }
}
