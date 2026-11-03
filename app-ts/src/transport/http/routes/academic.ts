import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AcademicError, type AcademicService } from "../../../services/academic.js";

/**
 * /academic/* — 科研工作台 REST surface.
 *
 * Route layer only: uid from the gateway (X-Uid → request context), camelCase
 * JSON bodies passed to AcademicService, domain errors mapped to
 * { status, detail }. Ownership/validation live in the service.
 */
export function registerAcademicRoutes(app: FastifyInstance, deps: { academic: AcademicService }): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  /** Runs a handler, mapping AcademicError onto its HTTP status and everything else to a 500. */
  const run = async <T>(reply: FastifyReply, handler: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await handler();
    } catch (err) {
      if (err instanceof AcademicError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      throw err;
    }
  };

  // ---- projects -----------------------------------------------------------

  app.get("/academic/projects", async (_req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.listProjects(uid));
  });

  app.post("/academic/projects", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.createProject(uid, req.body));
  });

  app.get("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.getProject(uid, projectId));
  });

  app.patch("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.updateProject(uid, projectId, req.body));
  });

  app.delete("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.deleteProject(uid, projectId));
  });

  // ---- literature ---------------------------------------------------------

  app.get("/academic/projects/:projectId/literature", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listLiterature(uid, projectId, req.query));
  });

  app.post("/academic/projects/:projectId/literature", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.addLiterature(uid, projectId, req.body));
  });

  app.get("/academic/projects/:projectId/literature/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.exportBibtex(uid, projectId));
  });

  app.post("/academic/projects/:projectId/literature/:ref/verify", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, ref } = req.params as { projectId: string; ref: string };
    return run(reply, () => deps.academic.verifyLiterature(uid, projectId, decodeURIComponent(ref)));
  });

  app.delete("/academic/projects/:projectId/literature/:ref", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, ref } = req.params as { projectId: string; ref: string };
    return run(reply, () => deps.academic.removeLiterature(uid, projectId, decodeURIComponent(ref)));
  });

  app.get("/academic/literature/search", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.searchLiterature(uid, req.query));
  });

  // ---- documents ----------------------------------------------------------

  app.get("/academic/projects/:projectId/documents", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listDocuments(uid, projectId));
  });

  app.post("/academic/projects/:projectId/documents", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.createDocument(uid, projectId, req.body));
  });

  app.get("/academic/documents/:documentId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    return run(reply, () => deps.academic.getDocument(uid, documentId));
  });

  app.post("/academic/documents/:documentId/sections", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    return run(reply, () => deps.academic.saveSection(uid, documentId, req.body));
  });

  app.delete("/academic/documents/:documentId/sections/:sectionKey", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId, sectionKey } = req.params as { documentId: string; sectionKey: string };
    return run(reply, () => deps.academic.deleteSection(uid, documentId, decodeURIComponent(sectionKey)));
  });

  app.get("/academic/documents/:documentId/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    const query = req.query as { format?: string };
    return run(reply, () => deps.academic.exportDocument(uid, documentId, query.format));
  });

  // ---- events -------------------------------------------------------------

  app.get("/academic/projects/:projectId/events", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listEvents(uid, projectId, req.query));
  });
}
