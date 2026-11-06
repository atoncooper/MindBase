import { beforeEach, describe, expect, it } from "vitest";
import { KgService } from "../src/kg/service.js";
import { MemoryKgGraphRepository } from "../src/repository/memory/kg-graph.js";
import { MemoryKgSourceStore } from "../src/repository/memory/kg-sources.js";
import { MemoryKgBuildStore } from "../src/repository/memory/kg-builds.js";
import { MemoryKgDocStore } from "../src/repository/memory/kg-docs.js";
import { MemoryKgCloudSourceStore } from "../src/repository/memory/kg-cloud-sources.js";
import type { KgExtractor } from "../src/kg/extractor.js";
import type { ExtractionResult } from "../src/kg/types.js";
import type { CloudDocContent } from "../src/repository/kg-cloud-sources.js";
import type { EmbeddingsClient } from "../src/llm/embeddings.js";

const UID = "42";

const embeddings: EmbeddingsClient = {
  embedDocuments: async () => [],
  embedQuery: async () => [],
  probeDimension: async () => 8,
};

/** Fake extractor: scripts per (title, kind) and records what it saw. */
function fakeExtractor(script: (title: string, kind: string | undefined) => ExtractionResult): KgExtractor {
  return {
    extract: async (_text: string, title: string, kind?: string) => script(title, kind),
  } as unknown as KgExtractor;
}

/** Two entities + one relation, reused across documents. */
function twoEntities(): ExtractionResult {
  return {
    entities: [
      { name: "RNN", type: "tech", description: "循环神经网络", quote: "讲解 RNN 的梯度" },
      { name: "LSTM", type: "tech", description: "长短期记忆网络", quote: "LSTM 的门控机制" },
    ],
    relations: [{ src: "RNN", dst: "LSTM", relationType: "改进为", quote: "从 RNN 改进到 LSTM 的原文片段" }],
  };
}

function doc(uploadUuid: string, title: string, hash: string, text: string): CloudDocContent {
  return { uploadUuid, title, contentHash: hash, sizeChars: text.length, text };
}

describe("kg cloud build", () => {
  let graph: MemoryKgGraphRepository;
  let sources: MemoryKgSourceStore;
  let builds: MemoryKgBuildStore;
  let docs: MemoryKgDocStore;
  let cloud: MemoryKgCloudSourceStore;

  beforeEach(() => {
    graph = new MemoryKgGraphRepository();
    sources = new MemoryKgSourceStore();
    builds = new MemoryKgBuildStore();
    docs = new MemoryKgDocStore();
    cloud = new MemoryKgCloudSourceStore();
  });

  const makeService = (extractor: KgExtractor) =>
    new KgService({
      graph,
      extractor,
      sources,
      cloudSources: cloud,
      docs,
      builds,
      index: null,
      embeddings,
    });

  const seedTwoDocs = () => {
    cloud.seed(UID, doc("u-1", "第一篇", "h1", "第一篇正文，讲解 RNN 的梯度问题"));
    cloud.seed(UID, doc("u-2", "第二篇", "h2", "第二篇正文，讲解 LSTM 的门控机制"));
  };

  it("builds cloud-doc knowledge points: evidence edges + ledger + build record", async () => {
    seedTwoDocs();
    const kinds: Array<string | undefined> = [];
    const svc = makeService(
      fakeExtractor((_title, kind) => {
        kinds.push(kind);
        return twoEntities();
      }),
    );
    const { taskId, reused, completion } = await svc.startBuild(UID, { source: "cloud" });
    expect(reused).toBe(false);
    await completion!;

    const record = await builds.get(taskId, UID);
    expect(record?.status).toBe("done");
    expect(record?.source).toBe("cloud");
    expect(record?.docCount).toBe(2);
    expect(record?.result).toMatchObject({ total: 2, ok: 2, failed: 0 });
    expect(record?.steps.length).toBe(2);

    // the extractor is told it is reading a document (not a video transcript)
    expect(kinds).toEqual(["document", "document"]);

    // CloudDoc nodes + evidence edges (2 docs × 2 entities, delete-before-write per doc)
    expect(graph.cloudDocs.size).toBe(2);
    expect(graph.cloudAppearances.size).toBe(4);
    expect(graph.cloudDocs.get(`${UID}|u-1`)?.title).toBe("第一篇");
    expect(graph.cloudDocs.get(`${UID}|u-1`)?.contentHash).toBe("h1");
    // cloud knowledge points share the entity/relation space with videos
    expect(graph.entities.size).toBe(2);
    expect(graph.relations.size).toBe(1);

    // ledger: both docs done, content hash recorded
    const first = await docs.get(UID, "u-1");
    expect(first?.status).toBe("done");
    expect(first?.contentHash).toBe("h1");
    expect(first?.entityCount).toBe(2);
    expect(first?.relationCount).toBe(1);
    expect((await docs.get(UID, "u-2"))?.status).toBe("done");

    // stats expose the additive cloud counters
    const stats = await svc.stats();
    expect(stats.graph.cloudDocs).toBe(2);
    expect(stats.graph.cloudEvidence).toBe(4);
    expect(stats.graph.videos).toBe(0);
  });

  it("skips unchanged documents by content hash (no LLM call, no graph rewrite)", async () => {
    seedTwoDocs();
    let calls = 0;
    const svc = makeService(
      fakeExtractor(() => {
        calls += 1;
        return { entities: [{ name: "RNN", type: "tech", description: "", quote: "讲解 RNN 的梯度" }], relations: [] };
      }),
    );
    const first = await svc.startBuild(UID, { source: "cloud" });
    await first.completion!;
    expect(calls).toBe(2);
    const evidenceAfterFirst = graph.cloudAppearances.size;

    const second = await svc.startBuild(UID, { source: "cloud" });
    await second.completion!;
    expect(calls).toBe(2); // skipped before any extraction
    expect(graph.cloudAppearances.size).toBe(evidenceAfterFirst);
    const secondRecord = await builds.get(second.taskId, UID);
    expect(secondRecord?.result).toMatchObject({ total: 2, ok: 2, failed: 0 });
    expect(secondRecord?.result?.message).toContain("跳过未变更文档 2 篇");
  });

  it("re-extracts a document whose content hash changed and keeps evidence deduped", async () => {
    cloud.seed(UID, doc("u-1", "第一篇", "h1", "第一篇正文，讲解 RNN 的梯度问题"));
    let calls = 0;
    const svc = makeService(
      fakeExtractor(() => {
        calls += 1;
        return { entities: [{ name: "RNN", type: "tech", description: "", quote: "讲解 RNN 的梯度" }], relations: [] };
      }),
    );
    const first = await svc.startBuild(UID, { source: "cloud" });
    await first.completion!;
    expect(calls).toBe(1);

    cloud.seed(UID, doc("u-1", "第一篇（改版）", "h2", "改版后的正文，仍然讲解 RNN"));
    const second = await svc.startBuild(UID, { source: "cloud" });
    await second.completion!;
    expect(calls).toBe(2);
    expect((await docs.get(UID, "u-1"))?.contentHash).toBe("h2");
    expect(graph.cloudDocs.get(`${UID}|u-1`)?.title).toBe("第一篇（改版）");
    expect(graph.cloudAppearances.size).toBe(1); // replaced, not duplicated
  });

  it("isolates per-document failures and records them as failed", async () => {
    seedTwoDocs();
    const svc = makeService(
      fakeExtractor((title) => {
        if (title === "第一篇") throw new Error("LLM timeout");
        return { entities: [{ name: "LSTM", type: "tech", description: "", quote: "LSTM 的门控机制" }], relations: [] };
      }),
    );
    const { taskId, completion } = await svc.startBuild(UID, { source: "cloud" });
    await completion!;

    const record = await builds.get(taskId, UID);
    expect(record?.status).toBe("done");
    expect(record?.result).toMatchObject({ total: 2, ok: 1, failed: 1 });
    expect((await docs.get(UID, "u-1"))?.status).toBe("failed");
    expect((await docs.get(UID, "u-1"))?.error).toContain("LLM timeout");
    expect((await docs.get(UID, "u-2"))?.status).toBe("done");
    // only the successful document wrote evidence
    expect(graph.cloudDocs.size).toBe(1);
    expect(graph.cloudAppearances.size).toBe(1);
  });

  it("processes only the explicit upload_uuids scope (deduped)", async () => {
    seedTwoDocs();
    cloud.seed(UID, doc("u-3", "第三篇", "h3", "第三篇正文，讲解 Transformer"));
    let calls = 0;
    const svc = makeService(
      fakeExtractor(() => {
        calls += 1;
        return { entities: [], relations: [] };
      }),
    );
    const { taskId, completion } = await svc.startBuild(UID, {
      source: "cloud",
      uploadUuids: ["u-1", "u-3", "u-1"],
    });
    await completion!;
    expect(calls).toBe(2);
    expect((await builds.get(taskId, UID))?.docCount).toBe(2);
    expect(await docs.get(UID, "u-1")).toBeDefined();
    expect(await docs.get(UID, "u-3")).toBeDefined();
    expect(await docs.get(UID, "u-2")).toBeUndefined();
  });

  it("fails a document whose body is empty (not parsed yet)", async () => {
    cloud.seed(UID, doc("u-1", "空文档", "h1", ""));
    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    const { taskId, completion } = await svc.startBuild(UID, { source: "cloud" });
    await completion!;
    expect((await builds.get(taskId, UID))?.result).toMatchObject({ total: 1, ok: 0, failed: 1 });
    expect((await docs.get(UID, "u-1"))?.status).toBe("failed");
  });

  it("clears stale evidence when a changed document now yields no entities", async () => {
    cloud.seed(UID, doc("u-1", "第一篇", "h1", "第一篇正文，讲解 RNN 的梯度问题"));
    const svc = makeService(
      fakeExtractor(() => ({
        entities: [{ name: "RNN", type: "tech", description: "", quote: "讲解 RNN 的梯度" }],
        relations: [],
      })),
    );
    const first = await svc.startBuild(UID, { source: "cloud" });
    await first.completion!;
    expect(graph.cloudAppearances.size).toBe(1);

    cloud.seed(UID, doc("u-1", "第一篇", "h2", "改版正文，没有可抽取的实体"));
    const svc2 = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    const second = await svc2.startBuild(UID, { source: "cloud" });
    await second.completion!;
    expect(graph.cloudAppearances.size).toBe(0);
    expect((await docs.get(UID, "u-1"))?.entityCount).toBe(0);
  });

  it("503s when app-cloud is not configured, 404s when the drive has no parsed docs", async () => {
    const noCloud = new KgService({
      graph,
      extractor: fakeExtractor(() => ({ entities: [], relations: [] })),
      sources,
      cloudSources: null,
      docs,
      builds,
      index: null,
      embeddings,
    });
    await expect(noCloud.startBuild(UID, { source: "cloud" })).rejects.toMatchObject({ status: 503 });

    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    await expect(svc.startBuild(UID, { source: "cloud" })).rejects.toMatchObject({ status: 404 });
  });

  it("reuses the active task instead of starting a second cloud build", async () => {
    seedTwoDocs();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const svc = makeService({
      extract: () => gate.then(() => ({ entities: [], relations: [] })),
    } as unknown as KgExtractor);
    const first = await svc.startBuild(UID, { source: "cloud" });
    expect(first.reused).toBe(false);
    const second = await svc.startBuild(UID, { source: "cloud" });
    expect(second.reused).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(second.completion).toBeUndefined();
    release?.();
    await first.completion!;
  });
});
