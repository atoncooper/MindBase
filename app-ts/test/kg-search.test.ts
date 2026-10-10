import { describe, expect, it } from "vitest";
import { KgRetriever } from "../src/kg/retriever.js";
import { MemoryKgGraphRepository } from "../src/repository/memory/kg-graph.js";
import { eidForName } from "../src/kg/resolver.js";
import type { KgEntityIndex, EntityHit } from "../src/repository/kg-entity-index.js";
import type { EmbeddingsClient } from "../src/llm/embeddings.js";
import type { ResolvedEntity } from "../src/kg/types.js";

/** Fake entity index: matches any query against seeded entities with a fixed score. */
function fakeIndex(entities: ResolvedEntity[], score: number, available = true): KgEntityIndex {
  return {
    available,
    search: async (_query: string, topN: number): Promise<EntityHit[]> =>
      entities.slice(0, topN).map((e) => ({ eid: e.eid, name: e.name, type: e.type, score })),
  } as unknown as KgEntityIndex;
}

const embeddings: EmbeddingsClient = {
  embedDocuments: async () => [],
  embedQuery: async () => [],
  probeDimension: async () => 8,
};

function seedGraph() {
  const graph = new MemoryKgGraphRepository();
  const rnn: ResolvedEntity = { eid: eidForName("RNN"), name: "RNN", nameLower: "rnn", type: "tech", description: "循环神经网络", quote: "" };
  const lstm: ResolvedEntity = { eid: eidForName("LSTM"), name: "LSTM", nameLower: "lstm", type: "tech", description: "长短期记忆网络", quote: "" };
  graph.entities.set(rnn.nameLower, rnn);
  graph.entities.set(lstm.nameLower, lstm);
  graph.relations.set(`${rnn.eid}|${lstm.eid}|改进为`, { srcEid: rnn.eid, dstEid: lstm.eid, relType: "改进为", weight: 1, quotes: ["从 RNN 改进到 LSTM"] });
  graph.appearances.set("BV1|0|" + rnn.eid, { bvid: "BV1", pageIndex: 0, eid: rnn.eid, quote: "讲解 RNN 的梯度问题" });
  graph.seedPage({ bvid: "BV1", cid: 11, pageIndex: 0, pageTitle: "序列模型", version: 1 });
  return { graph, rnn, lstm };
}

describe("kg retriever", () => {
  it("links seeds, expands the graph and builds vector_search-isomorphic sources", async () => {
    const { graph, rnn, lstm } = seedGraph();
    const retriever = new KgRetriever({
      graph,
      index: fakeIndex([rnn, lstm], 0.8),
      embeddings,
    });
    expect(retriever.isAvailable()).toBe(true);

    const result = await retriever.retrieve("RNN 和 LSTM 的关系", ["BV1"], 8);
    expect(result.entityCount).toBe(2);
    expect(result.evidenceCount).toBe(1);
    expect(result.content).toContain("## RNN（tech）");
    expect(result.content).toContain("RNN --改进为--> LSTM");
    expect(result.content).toContain('出处：【序列模型】"讲解 RNN 的梯度问题"');
    expect(result.sources).toEqual([
      {
        bvid: "BV1",
        title: "序列模型",
        url: "https://www.bilibili.com/video/BV1",
        score: 0.8,
        pageIndex: 0,
      },
    ]);
  });

  it("returns empty when no seed clears the score threshold", async () => {
    const { graph, rnn } = seedGraph();
    const retriever = new KgRetriever({ graph, index: fakeIndex([rnn], 0.3), embeddings });
    const result = await retriever.retrieve("不相关的查询", ["BV1"], 8);
    expect(result).toEqual({ content: "", sources: [], entityCount: 0, evidenceCount: 0 });
  });

  it("degrades to empty results when the graph traversal throws", async () => {
    const { graph, rnn } = seedGraph();
    graph.available = false;
    const retriever = new KgRetriever({ graph, index: fakeIndex([rnn], 0.9), embeddings });
    const result = await retriever.retrieve("RNN", ["BV1"], 8);
    expect(result.content).toBe("");
  });
});
