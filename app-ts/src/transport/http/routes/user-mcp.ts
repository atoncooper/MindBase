import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { UserMcpError, type UserMcpBridge } from "../../../mcp/user-connections.js";

function uidOf(_req: FastifyRequest): string | undefined {
  const uid = getRequestContext()?.uid;
  return typeof uid === "string" ? uid : undefined;
}

function respond(reply: FastifyReply, err: unknown) {
  if (err instanceof UserMcpError) return reply.status(err.status).send({ detail: err.message });
  throw err;
}

/**
 * MCP protocol faces that must run in app-ts (it owns the MCP client):
 * tools/list discovery and its write-back to app-user. CRUD itself lives in
 * app-user: /settings/mcp/servers.
 */
export function registerUserMcpRoutes(app: FastifyInstance, deps: { service: UserMcpBridge }): void {
  app.post("/mcp/servers/:id/discover", async (req, reply) => {
    const uid = uidOf(req);
    if (!uid) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const raw = (req.params as { id: string }).id;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) return reply.status(404).send({ detail: "MCP server 不存在" });
    try {
      return await deps.service.discover(uid, id);
    } catch (err) {
      return respond(reply, err);
    }
  });
}
