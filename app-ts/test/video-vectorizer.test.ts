import { describe, it, expect, afterEach } from "vitest";
import { MemoryVectorTaskStore } from "../src/repository/memory/vector-tasks.js";
import { VideoVectorizerService, VecError } from "../src/services/video-vectorizer.js";
import { QuotaService } from "../src/services/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { config } from "../src/config/index.js";
import { buildServer } from "../src/transport/http/server.js";
import type { RAGService } from "../src/rag/service.js";
import type { ChatService } from "../src/services/chat.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";
import type { AppBiliClient, ScopeFolder } from "../src/services/app-bili-client.js";

// ---------- service ----------

function makeDeps(opts: {
  content?: string;
  chunkCount?: number;
  asrError?: Error;
  quota?: QuotaService;
} = {}) {
  const added: Array<Record<string, unknown>> = [];
  const deletedPages: string[] = [];
  const deletedVideos: string[] = [];
  const tasks = new MemoryVectorTaskStore();
  const sources = {
    getLatest: async (bvid: string, cid: number) => {
      if (opts.content === undefined) return undefined;
      void bvid;
      void cid;
      return { content: opts.content, pageTitle: "P1" };
    },
    close: async () => {},
  };
  const rag = {
    addVideoContent: async (video: Record<string, unknown>) => {
      added.push(video);
      return opts.chunkCount ?? 4;
    },
    deletePageVectors: async (bvid: string, pageIndex: number) => {
      deletedPages.push(`${bvid}:${pageIndex}`);
    },
    deleteVideo: async (bvid: string) => {
      deletedVideos.push(bvid);
    },
  };
  const asr = {
    ensureAsr: async () => {
      if (opts.asrError) throw opts.asrError;
    },
  };
  const vectorizer = new VideoVectorizerService({
    rag,
    sources,
    tasks,
    asr,
    ...(opts.quota ? { quota: opts.quota } : {}),
  });
  return { vectorizer, tasks, added, deletedPages, deletedVideos };
}

const CONTENT = "x".repeat(120);


const savedQuota = structuredClone(config.quota);
afterEach(() => {
  config.quota = structuredClone(savedQuota);
});
describe("VideoVectorizerService × quota", () => {
  it("defers (no task, no error) once the daily page budget is exhausted", async () => {
    config.quota.limits.vectorize = { free: 1, vip: 300, svip: 1000 };
    const quota = new QuotaService({ counter: new MemoryQuotaCounter(), resolveTier: async () => "free" });
    const { vectorizer } = makeDeps({ content: CONTENT, quota });

    const first = await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11, pageIndex: 0 });
    expect(first.task_id).toBeTruthy();

    const second = await vectorizer.createTask({ uid: "7", bvid: "BV2", cid: 22, pageIndex: 0 });
    expect(second.task_id).toBeNull(); // 顺延：不报错、不建任务，次日可续
    expect(second.message).toContain("向量化额度已用完");
  });

  it("revector refuses with 429 over the budget", async () => {
    config.quota.limits.vectorize = { free: 0, vip: 300, svip: 1000 };
    const quota = new QuotaService({ counter: new MemoryQuotaCounter(), resolveTier: async () => "free" });
    const { vectorizer } = makeDeps({ content: CONTENT, quota });
    await expect(vectorizer.revector({ uid: "7", bvid: "BV1", cid: 11 })).rejects.toMatchObject({ status: 429 });
  });
});

describe("VideoVectorizerService", () => {
  it("createTask runs the pipeline to done and records chunk count", async () => {
    const { vectorizer, tasks, added, deletedPages } = makeDeps({ content: CONTENT });
    const { task_id: taskId } = await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11, pageIndex: 0, pageTitle: "P1" });
    expect(taskId).toBeTruthy();
    // wait for the background pipeline
    for (let i = 0; i < 50 && (await tasks.getPage("BV1", 11))?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const page = await tasks.getPage("BV1", 11);
    expect(page).toMatchObject({ status: "done", chunkCount: 4 });
    expect(page?.contentHash).toBeTruthy();
    expect(added).toHaveLength(1);
    expect(deletedPages).toContain("BV1:0");

    const status = await vectorizer.taskStatus(taskId!, "7");
    expect(status.status).toBe("done");
    expect(status.steps.map((s) => s.name)).toContain("vec");
  });

  it("createTask is idempotent for done + unchanged content", async () => {
    const { vectorizer } = makeDeps({ content: CONTENT });
    const first = await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
    const second = await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    void first;
    expect(second).toEqual({ task_id: null, message: "Already up to date" });
  });

  it("delegates ASR when no content exists, fails when still nothing", async () => {
    // no content initially; asr delegate does not add any → pipeline fails
    const { vectorizer, tasks } = makeDeps({ content: undefined });
    await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    for (let i = 0; i < 50 && (await tasks.getPage("BV1", 11))?.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const page = await tasks.getPage("BV1", 11);
    expect(page?.status).toBe("failed");
    expect(page?.error).toContain("no content saved");
  });

  it("taskStatus enforces uid ownership (IDOR guard)", async () => {
    const { vectorizer, tasks } = makeDeps({ content: CONTENT });
    const { task_id: taskId } = await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    void tasks;
    await expect(vectorizer.taskStatus(taskId!, "99")).rejects.toThrow(VecError);
    await expect(vectorizer.taskStatus("missing", "7")).rejects.toMatchObject({ status: 404 });
  });

  it("revector refuses without ASR content (400/404 contract)", async () => {
    const { vectorizer } = makeDeps({ content: undefined });
    await expect(vectorizer.revector({ uid: 7, bvid: "BVnone", cid: 1 })).rejects.toMatchObject({ status: 404 });
    // a page record exists (created earlier) but content missing → 400
    await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    await new Promise((r) => setTimeout(r, 30));
    await expect(vectorizer.revector({ uid: 7, bvid: "BV1", cid: 11 })).rejects.toMatchObject({ status: 400 });
  });

  it("deleteVideo clears vectors and bookkeeping; listDonePages reflects state", async () => {
    const { vectorizer, tasks, deletedVideos } = makeDeps({ content: CONTENT });
    await vectorizer.createTask({ uid: "7", bvid: "BV1", cid: 11 });
    for (let i = 0; i < 50 && (await tasks.getPage("BV1", 11))?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await vectorizer.listDonePages()).map((p) => p.bvid)).toContain("BV1");
    await vectorizer.deleteVideo("BV1");
    expect(deletedVideos).toEqual(["BV1"]);
    expect(await tasks.getPage("BV1", 11)).toBeUndefined();
    expect(await vectorizer.listDonePages()).toHaveLength(0);
  });
});

// ---------- routes ----------

function fakeAppBili(folders: ScopeFolder[], error = false): AppBiliClient {
  return {
    scope: async () => {
      if (error) throw new Error("bili down");
      return folders;
    },
    owns: async (_uid: number, bvid: string) => folders.some((f) => f.videos.some((v) => v.bvid === bvid)),
    invalidateScope: () => {},
  } as unknown as AppBiliClient;
}

describe("vector/knowledge routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  const fakeRag = {
    getCollectionStats: async () => ({ collectionName: "bilibili_videos", totalChunks: 12, totalVideos: 3, available: true }),
    addVideoContent: async () => 4,
    deletePageVectors: async () => {},
    deleteVideo: async () => {},
    countPageVectors: async () => 0,
    clearVideoCollection: async () => {},
  } as unknown as RAGService;
  const fakeHarness = { runtimeStatus: () => ({}) } as unknown as AgentHarness;
  const fakeDocs: SessionDocumentRepository = {
    save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
    list: async () => [],
    search: async () => [],
    deleteBySession: async () => 0,
  };
  const chat = {} as ChatService;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const build = async (folders: ScopeFolder[], error = false) => {
    const tasks = new MemoryVectorTaskStore();
    const sources = {
      getLatest: async () => ({ content: CONTENT, pageTitle: "P1" }),
      close: async () => {},
    };
    const vectorizer = new VideoVectorizerService({ rag: fakeRag, sources, tasks });
    const appBili = fakeAppBili(folders, error);
    app = await buildServer({
      chat,
      harness: fakeHarness,
      rag: fakeRag,
      sessionDocs: fakeDocs,
      vectorizer,
      appBili,
    } as Parameters<typeof buildServer>[0]);
    return { tasks, appBili };
  };

  const scopeFolders = (): ScopeFolder[] => [
    {
      media_id: 5,
      media_count: 2,
      last_sync_at: "2026-10-06T00:00:00",
      videos: [
        { bvid: "BV1", title: "视频一", pages: [{ cid: 11, page_index: 0, page_title: "P1", is_processed: true, version: 1 }] },
        { bvid: "BV2", title: "视频二", pages: [{ cid: 22, page_index: 0, page_title: "P1", is_processed: true, version: 1 }] },
      ],
    },
  ];

  it("GET /vec/page/status returns the not-found shape for unknown pages", async () => {
    await build([]);
    const res = await app!.inject({ method: "GET", url: "/vec/page/status?bvid=BVx&cid=1", headers: { "x-uid": "7" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exists: false, is_vectorized: "pending", vector_chunk_count: 0 });
  });

  it("POST /vec/page/create requires X-Uid and reports task creation", async () => {
    await build([]);
    const noAuth = await app!.inject({ method: "POST", url: "/vec/page/create", payload: { bvid: "BV1", cid: 11 } });
    expect(noAuth.statusCode).toBe(401);

    const res = await app!.inject({
      method: "POST",
      url: "/vec/page/create",
      payload: { bvid: "BV1", cid: 11, page_index: 0 },
      headers: { "x-uid": "7" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task_id).toBeTruthy();
    expect(res.json().message).toBe("Vectorization task created");
  });

  it("GET /knowledge/stats mirrors the snake_case contract", async () => {
    await build([]);
    const res = await app!.inject({ method: "GET", url: "/knowledge/stats", headers: { "x-uid": "7" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total_chunks: 12, total_videos: 3, collection_name: "bilibili_videos" });
  });

  it("GET /knowledge/folders/status counts only fully-vectorized videos", async () => {
    const { tasks } = await build(scopeFolders());
    // BV1 done, BV2 not started → indexed_count = 1
    await tasks.upsertPage({
      bvid: "BV1", cid: 11, pageIndex: 0, pageTitle: "P1", status: "done", chunkCount: 4, updatedAt: Date.now(),
    });
    const res = await app!.inject({ method: "GET", url: "/knowledge/folders/status", headers: { "x-uid": "7" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { media_id: 5, indexed_count: 1, media_count: 2, last_sync_at: "2026-10-06T00:00:00" },
    ]);
  });

  it("GET /knowledge/pages/vectorized joins scope × done pages with video titles", async () => {
    const { tasks } = await build(scopeFolders());
    await tasks.upsertPage({
      bvid: "BV1", cid: 11, pageIndex: 0, pageTitle: "P1", status: "done", chunkCount: 6, vectorizedAt: 1760000000000, updatedAt: Date.now(),
    });
    const res = await app!.inject({ method: "GET", url: "/knowledge/pages/vectorized", headers: { "x-uid": "7" } });
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ bvid: "BV1", cid: 11, video_title: "视频一", vector_chunk_count: 6 });
  });

  it("DELETE /knowledge/video/:bvid enforces ownership (403 for foreign bvids, admin bypass)", async () => {
    await build(scopeFolders());
    const foreign = await app!.inject({ method: "DELETE", url: "/knowledge/video/BV999", headers: { "x-uid": "7" } });
    expect(foreign.statusCode).toBe(403);

    const own = await app!.inject({ method: "DELETE", url: "/knowledge/video/BV1", headers: { "x-uid": "7" } });
    expect(own.statusCode).toBe(200);
    expect(own.json().message).toContain("BV1");

    const admin = await app!.inject({ method: "DELETE", url: "/knowledge/video/BV999", headers: { "x-uid": "7", "x-roles": "admin" } });
    expect(admin.statusCode).toBe(200);
  });

  it("DELETE /knowledge/clear is admin-gated", async () => {
    await build([]);
    const user = await app!.inject({ method: "DELETE", url: "/knowledge/clear", headers: { "x-uid": "7" } });
    expect(user.statusCode).toBe(403);
    const admin = await app!.inject({ method: "DELETE", url: "/knowledge/clear", headers: { "x-uid": "7", "x-roles": "admin" } });
    expect(admin.statusCode).toBe(200);
  });

  it("POST /chat/search dedups by bvid and caps previews", async () => {
    const tasks = new MemoryVectorTaskStore();
    const sources = { getLatest: async () => undefined, close: async () => {} };
    const searchRag = {
      getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: true }),
      search: async () => [
        { text: "a".repeat(300), metadata: { bvid: "BV1", title: "t1", url: "u1" } },
        { text: "b", metadata: { bvid: "BV1", title: "t1", url: "u1" } },
      ],
    } as unknown as RAGService;
    const vectorizer = new VideoVectorizerService({ rag: searchRag, sources, tasks });
    app = await buildServer({
      chat,
      harness: fakeHarness,
      rag: searchRag,
      sessionDocs: fakeDocs,
      vectorizer,
      appBili: fakeAppBili([]),
    } as Parameters<typeof buildServer>[0]);

    const res = await app.inject({
      method: "POST",
      url: "/chat/search",
      payload: { query: "test" },
      headers: { "x-uid": "7" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].content_preview.endsWith("...")).toBe(true);

    const empty = await app.inject({ method: "POST", url: "/chat/search", payload: { query: "" }, headers: { "x-uid": "7" } });
    expect(empty.statusCode).toBe(400);
  });
});
