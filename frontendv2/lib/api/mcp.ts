import { getAuthHeaders, request } from "./client";

/** MCP auth: static API key (bearer/custom header) or OAuth 2.1. */
export type McpAuthKind = "none" | "bearer" | "header" | "oauth";

export interface UserMcpTool {
    name: string;
    description?: string;
}

/** Safe wire shape from app-user's settings domain (/settings/mcp/servers). */
export interface UserMcpServer {
    id: number;
    name: string;
    url: string;
    auth_kind: McpAuthKind;
    auth_header?: string;
    /** Masked key; the plaintext is never returned to the browser. */
    api_key_masked?: string;
    enabled: boolean;
    tools: UserMcpTool[];
    last_error?: string;
    /** OAuth: a token is stored for this connection. */
    oauth_authorized?: boolean;
    oauth_issuer?: string;
    oauth_expires_at?: string;
    created_at?: string;
    updated_at?: string;
}

export interface UserMcpInput {
    name: string;
    url: string;
    auth_kind: McpAuthKind;
    api_key?: string;
    auth_header?: string;
    enabled?: boolean;
}

export const mcpApi = {
    /** CRUD lives in app-user's settings domain, next to Coding Plan. */
    list: () =>
        request<{ enabled: boolean; servers: UserMcpServer[] }>("/settings/mcp/servers", {
            headers: getAuthHeaders(),
        }),

    create: (input: UserMcpInput) =>
        request<{ server: UserMcpServer }>("/settings/mcp/servers", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(input),
        }),

    update: (id: number, input: Partial<UserMcpInput>) =>
        request<{ server: UserMcpServer }>(`/settings/mcp/servers/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(input),
        }),

    remove: (id: number) =>
        request<{ message: string }>(`/settings/mcp/servers/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    /** tools/list runs in app-ts (it owns the MCP protocol); the result is
     *  written back to app-user and returned for the row display. */
    discover: (id: number) =>
        request<UserMcpServer>(`/mcp/servers/${id}/discover`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** Start the OAuth 2.1 flow; navigate the browser to authorization_url. */
    startOAuth: (id: number) =>
        request<{ authorization_url: string; expires_at: number }>(`/settings/mcp/servers/${id}/oauth/start`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** Drop the stored OAuth tokens (connection falls back to unauthenticated). */
    disconnectOAuth: (id: number) =>
        request<{ message: string }>(`/settings/mcp/servers/${id}/oauth`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),
};
