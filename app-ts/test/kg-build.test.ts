import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KgService, KgServiceError } from "../src/kg/service.js";
import { MemoryKgGraphRepository } from "../src/repository/memory/kg-graph.js";
import { MemoryKgSourceStore } from "../src/repository/memory/kg-sources.js";
import { MemoryKgBuildStore } from "../src/repository/memory/kg-builds.js";
import type { KgExtractor } from "../src/kg/extractor.js";
import type { ExtractionResult } from "../src/kg/types.js";

/** Fake extractor: scripted per-title responses or a fixed failure. */
function fakeExtractor(script: (title: string) => ExtractionResult): KgExtractor {
  return { extract: async (_text: string, title: string) => script(title) } as unknown as KgExtractor;
}

describe("kg build service", () => {
  let graph: MemoryKgGraphRepository;
  let sources: MemoryKgSourceStore;
  let builds: MemoryKgBuildStore;

  beforeEach(() => {
    graph = new MemoryKgGraphRepository();
    sources = new MemoryKgSourceStore();
    builds = new MemoryKgBuildStore();
  });

  const makeService = (extractor: KgExtractor) =>
    new KgService({
      graph,
      extractor,
      sources,
      builds,
      index: null, // entity-vector writes are best-effort; absent index is exercised
      embeddings: {
        embedDocuments: async () => [],
        embedQuery: async () => [],
        probeDimension: async () => 8,
      },
    });

  const seedTwoPages = () => {
    graph.seedPage({ bvid: "BV1", cid: 11, pageIndex: 0, pageTitle: "第一课", version: 1 });
    graph.seedPage({ bvid: "BV1", cid: 12, pageIndex: 1, pageTitle: "第二课", version: 1 });
    sources.seed("BV1", 11, { content: "第一课的文字稿，讲解 RNN 的梯度问题", pageTitle: "第一课" });
    sources.seed("BV1", 12, { content: "第二课的文字稿，讲解 LSTM 的门控机制", pageTitle: "第二课" });
  };

  it("runs the full pipeline: extraction → graph writes → markPageDone", async () => {
    seedTwoPages();
    const svc = makeService(
      fakeExtractor(() => ({
        entities: [
          { name: "RNN", type: "tech", description: "循环神经网络", quote: "讲解 RNN 的梯度" },
          { name: "LSTM", type: "tech", description: "长短期记忆网络", quote: "LSTM 的门控机制" },
        ],
        relations: [
          { src: "RNN", dst: "LSTM", relationType: "改进为", quote: "从 RNN 改进到 LSTM 的过程" },
        ],
      })),
    );
    const { taskId, reused, completion } = await svc.startBuild(1, [100]);
    expect(reused).toBe(false);
    await completion!;

    const record = await builds.get(taskId, 1);
    expect(record?.status).toBe("done");
    expect(record?.result).toMatchObject({ total: 2, ok: 2, failed: 0 });
    // graph got the entities/relations/evidence (same two entities extracted
    // for both pages → 2 pages × 2 entities = 4 evidence edges, delete-before-write per page)
    expect(graph.entities.size).toBe(2);
    expect(graph.relations.size).toBe(1);
    expect(graph.appearances.size).toBe(4);
    // pages marked done with the content version
    expect(graph.pages.get("BV1|11")?.kgStatus).toBe("done");
    expect(graph.pages.get("BV1|11")?.kgVersion).toBe(1);
    // pages become non-pending
    expect(await graph.countPendingPages()).toBe(0);
  });

  it("isolates per-page failures: failed page retryable, batch completes with counts", async () => {
    seedTwoPages();
    let calls = 0;
    const svc = makeService(
      fakeExtractor((title) => {
        calls += 1;
        if (title === "第一课") throw new Error("LLM timeout");
        return { entities: [{ name: "LSTM", type: "tech", description: "", quote: "LSTM 的门控机制" }], relations: [] };
      }),
    );
    const { completion } = await svc.startBuild(1, []);
    await completion!;

    expect(graph.pages.get("BV1|11")?.kgStatus).toBe("failed");
    expect(graph.pages.get("BV1|12")?.kgStatus).toBe("done");
    expect(calls).toBe(2);
  });

  it("completes with a message when no pages are pending", async () => {
    seedTwoPages();
    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    const first = await svc.startBuild(1, []);
    await first.completion!;
    expect(builds.get(first.taskId, 1).then((r) => r?.result)).resolves.toMatchObject({ ok: 2 });

    // everything now up-to-date → second build: total 0
    const second = await svc.startBuild(1, []);
    expect(second.reused).toBe(false);
    await second.completion!;
    await expect(builds.get(second.taskId, 1).then((r) => r?.result)).resolves.toMatchObject({
      total: 0,
      message: "所有分P已是最新",
    });
  });

  it("skips pages already done at the current content version (beginPage skip)", async () => {
    seedTwoPages();
    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    const first = await svc.startBuild(1, []);
    await first.completion!;
    // re-running with the same expected versions → selectPendingPages already filters them;
    // a direct processPage with expected_version set still skips via BeginPage
    const page = graph.pages.get("BV1|11")!;
    const outcome = await svc.processPage(page.bvid, page.cid, page.pageIndex, page.pageTitle, page.version);
    expect(outcome).toEqual({ entities: 0, relations: 0, droppedRelations: 0 });
  });

  it("reuses the active task instead of starting a second one (per-uid guard)", async () => {
    seedTwoPages();
    // extractor that never resolves → keeps the build "processing"
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const svc = new KgService({
      graph,
      extractor: {
        extract: () => gate.then(() => ({ entities: [], relations: [] })),
      } as unknown as KgExtractor,
      sources,
      builds,
      index: null,
      embeddings: { embedDocuments: async () => [], embedQuery: async () => [], probeDimension: async () => 8 },
    });
    const first = await svc.startBuild(1, []);
    expect(first.reused).toBe(false);
    const second = await svc.startBuild(1, []);
    expect(second.reused).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(second.completion).toBeUndefined();
    release?.();
    await first.completion!;
  });

  it("404s when the scope resolves to no videos, 503s when the graph is down", async () => {
    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    await expect(svc.startBuild(1, [])).rejects.toMatchObject({ status: 404 });
    graph.available = false;
    await expect(svc.startBuild(1, [])).rejects.toBeInstanceOf(KgServiceError);
  });

  it("fails the page when the ASR transcript is missing", async () => {
    graph.seedPage({ bvid: "BV2", cid: 21, pageIndex: 0, pageTitle: "无正文", version: 1 });
    const svc = makeService(fakeExtractor(() => ({ entities: [], relations: [] })));
    const { completion } = await svc.startBuild(2, []);
    await completion!;
    expect(graph.pages.get("BV2|21")?.kgStatus).toBe("failed");
  });
});
