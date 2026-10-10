import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { SkillError, SkillManager, SkillStoreClient } from "../../../skills/manager.js";

/**
 * /skills — per-user installed skills + GitHub store browser (contract mirror
 * of the Python router the frontend skillsApi consumes). Identity =
 * gateway-injected X-Uid.
 */
export function registerSkillsRoutes(
  app: FastifyInstance,
  deps: { manager: SkillManager; store: SkillStoreClient },
): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const respondError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SkillError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  app.get("/skills/installed", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    try {
      const skills = await deps.manager.listInstalled(uid);
      return skills.map((s) => ({
        skill_id: s.skillId,
        name: s.name,
        description: s.description,
        version: s.version,
        source_store: s.sourceStore,
        has_code_tools: s.hasCodeTools,
        enabled: s.enabled,
      }));
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.post("/skills/install", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    try {
      const multipart = req as unknown as {
        file: (o?: unknown) => Promise<{ toBuffer: () => Promise<Buffer>; filename: string } | undefined>;
      };
      const file = await multipart.file({ limits: { fileSize: 20 * 1024 * 1024 } });
      if (!file) return reply.status(400).send({ detail: "缺少文件（multipart 字段名 file）" });
      const zip = await file.toBuffer();
      const installed = await deps.manager.install(uid, {
        skillId: file.filename.replace(/\.zip$/i, ""),
        name: file.filename.replace(/\.zip$/i, ""),
        description: null,
        version: null,
        sourceStore: "upload",
        zip,
      });
      return {
        skill_id: installed.skillId,
        name: installed.name,
        description: installed.description,
        version: installed.version,
        source_store: installed.sourceStore,
        has_code_tools: installed.hasCodeTools,
        enabled: installed.enabled,
      };
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.delete("/skills/:skill_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { skill_id } = req.params as { skill_id: string };
    try {
      const deleted = await deps.manager.uninstall(uid, skill_id);
      return { deleted };
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/skills/:skill_id/preview", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { skill_id } = req.params as { skill_id: string };
    try {
      return await deps.manager.preview(uid, skill_id);
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/skills/store/list", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    try {
      const query = (req.query as { q?: string }).q;
      return await deps.store.search(query);
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.get("/skills/store/contents", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const query = req.query as { repo?: string; path?: string; branch?: string };
    if (!query.repo) return reply.status(400).send({ detail: "repo 必填（owner/repo）" });
    try {
      return await deps.store.contents(query.repo, query.branch || "main", query.path ?? "");
    } catch (err) {
      return respondError(reply, err);
    }
  });

  app.post("/skills/store/install", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const body = (req.body ?? {}) as { repo?: string; branch?: string };
    const repo = (body.repo ?? "").trim();
    if (!repo || !repo.includes("/")) {
      return reply.status(400).send({ detail: "repo 必填（owner/repo）" });
    }
    const branch = body.branch || "main";
    try {
      const zip = await deps.store.downloadZipball(repo, branch);
      const installed = await deps.manager.install(uid, {
        skillId: repo.split("/").pop() || repo,
        name: repo.split("/").pop() || repo,
        description: null,
        version: null,
        sourceStore: repo,
        zip,
      });
      return {
        skill_id: installed.skillId,
        name: installed.name,
        description: installed.description,
        version: installed.version,
        source_store: installed.sourceStore,
        has_code_tools: installed.hasCodeTools,
        enabled: installed.enabled,
      };
    } catch (err) {
      return respondError(reply, err);
    }
  });
}
