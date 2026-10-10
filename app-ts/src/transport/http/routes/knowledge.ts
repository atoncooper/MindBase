import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RAGService } from "../../../rag/service.js";
import type { VideoVectorizerService } from "../../../services/video-vectorizer.js";
import type { AppBiliClient } from "../../../services/app-bili-client.js";
import type { KgService } from "../../../kg/service.js";
import { getRequestContext } from "../../../context/request-context.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("HTTP");

/**
 * /knowledge/* (non-kg) — video knowledge-base management surface, contract
 * mirror of the Python router (snake_case wire): stats / folder status /
 * vectorized pages / clear (admin) / per-video delete. Folder scoping comes
 * from the app-bili knowledge scope; vector state from the vector task
 * repository; content from Milvus via RAGService.
 */
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  deps: { rag: RAGService; vectorizer: VideoVectorizerService; appBili: AppBiliClient; kg?: KgService },
): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  /** APISIX forward-auth injects X-Roles (client-supplied values are stripped at the gateway). */
  const isAdmin = (req: FastifyRequest): boolean => {
    const roles = req.headers["x-roles"];
    return typeof roles === "string" && roles.split(",").map((r) => r.trim()).includes("admin");
  };

  app.get("/knowledge/stats", async (req: FastifyRequest, reply: FastifyReply) => {
    if (requireUid(req) === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    try {
      const stats = await deps.rag.getCollectionStats();
      return {
        total_chunks: stats.totalChunks,
        total_videos: stats.totalVideos,
        collection_name: stats.collectionName,
      };
    } catch (err) {
      return reply.status(500).send({ detail: err instanceof Error ? err.message : "统计失败" });
    }
  });

  app.get("/knowledge/folders/status", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    try {
      const [folders, donePages] = await Promise.all([deps.appBili.scope(uid), deps.vectorizer.listDonePages()]);
      const doneKeys = new Set(donePages.map((p) => `${p.bvid}:${p.cid}`));
      return folders.map((folder) => ({
        media_id: folder.media_id,
        // indexed = videos whose every known page is fully vectorized
        indexed_count: folder.videos.filter(
          (v) => v.pages.length > 0 && v.pages.every((p) => doneKeys.has(`${v.bvid}:${p.cid}`)),
        ).length,
        media_count: folder.media_count,
        last_sync_at: folder.last_sync_at || null,
      }));
    } catch (err) {
      return reply.status(500).send({ detail: err instanceof Error ? err.message : "查询失败" });
    }
  });

  app.get("/knowledge/pages/vectorized", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    try {
      const [folders, donePages] = await Promise.all([deps.appBili.scope(uid), deps.vectorizer.listDonePages()]);
      const doneByBvid = new Map<string, Map<number, (typeof donePages)[number]>>();
      for (const page of donePages) {
        let byIndex = doneByBvid.get(page.bvid);
        if (!byIndex) {
          byIndex = new Map();
          doneByBvid.set(page.bvid, byIndex);
        }
        byIndex.set(page.pageIndex, page);
      }
      const seenBvids = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const folder of folders) {
        for (const video of folder.videos) {
          if (seenBvids.has(video.bvid)) continue;
          seenBvids.add(video.bvid);
          for (const scopePage of video.pages) {
            const page = doneByBvid.get(video.bvid)?.get(scopePage.page_index);
            if (!page) continue;
            items.push({
              bvid: video.bvid,
              cid: scopePage.cid,
              page_index: scopePage.page_index,
              page_title: page.pageTitle || scopePage.page_title || null,
              video_title: video.title || null,
              vector_chunk_count: page.chunkCount,
              vectorized_at: page.vectorizedAt ? new Date(page.vectorizedAt).toISOString() : null,
            });
          }
        }
      }
      return items;
    } catch (err) {
      return reply.status(500).send({ detail: err instanceof Error ? err.message : "查询失败" });
    }
  });

  app.delete("/knowledge/clear", async (req: FastifyRequest, reply: FastifyReply) => {
    if (requireUid(req) === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    if (!isAdmin(req)) {
      return reply.status(403).send({ detail: "需要管理员权限" });
    }
    try {
      await deps.rag.clearVideoCollection();
      await deps.vectorizer.clearAllPages();
      return { message: "知识库已清空" };
    } catch (err) {
      return reply.status(500).send({ detail: err instanceof Error ? err.message : "清空失败" });
    }
  });

  app.delete("/knowledge/video/:bvid", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    const { bvid } = req.params as { bvid: string };
    try {
      const owns = await deps.appBili.owns(uid, bvid);
      if (!owns && !isAdmin(req)) {
        return reply.status(403).send({ detail: "无权删除：该视频不在你的收藏夹中" });
      }
      await deps.vectorizer.deleteVideo(bvid);
      // KG cascade cleanup — best-effort, never fails the vector deletion.
      try {
        await deps.kg?.deleteVideoData(bvid);
      } catch (kgErr) {
        log.warn(`kg cascade cleanup failed bvid=${bvid}: ${kgErr instanceof Error ? kgErr.message : kgErr}`);
      }
      deps.appBili.invalidateScope(uid);
      return { message: `已删除视频 ${bvid}` };
    } catch (err) {
      return reply.status(500).send({ detail: err instanceof Error ? err.message : "删除失败" });
    }
  });
}
