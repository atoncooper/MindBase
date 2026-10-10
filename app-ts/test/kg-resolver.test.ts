import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_ENTITIES,
  DEFAULT_MAX_RELATIONS,
  eidForName,
  normalizeEntityType,
  normalizeName,
  resolveExtraction,
} from "../src/kg/resolver.js";

describe("kg resolver", () => {
  it("normalizeName lowercases and collapses whitespace like the Python impl", () => {
    expect(normalizeName("  Transformer   架构 ")).toBe("transformer 架构");
    expect(normalizeName("Attention\tIs\nAll You Need")).toBe("attention is all you need");
    expect(normalizeName("")).toBe("");
  });

  it("eidForName is sha1(nameLower utf-8) truncated to 16 hex chars (Python-compatible)", () => {
    const eid = eidForName("Transformer 架构");
    const expected = createHash("sha1").update("transformer 架构", "utf8").digest("hex").slice(0, 16);
    expect(eid).toBe(expected);
    expect(eid).toMatch(/^[0-9a-f]{16}$/);
    expect(eid).toBe(eidForName("  transformer \n 架构 ")); // normalization-stable
  });

  it("normalizeEntityType maps Chinese/English aliases to canonical types", () => {
    expect(normalizeEntityType("人物")).toBe("person");
    expect(normalizeEntityType("框架")).toBe("tech");
    expect(normalizeEntityType("PERSON")).toBe("person");
    expect(normalizeEntityType("company")).toBe("org");
    expect(normalizeEntityType("unknown-thing")).toBe("other");
    expect(normalizeEntityType("")).toBe("other");
  });

  it("dedups entities by normalized key keeping the first non-empty description/quote", () => {
    const result = resolveExtraction({
      entities: [
        { name: "Transformer", type: "tech", description: "", quote: "quote A" },
        { name: " transformer ", type: "tech", description: "架构模型", quote: "" },
      ],
      relations: [],
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].description).toBe("架构模型");
    expect(result.entities[0].quote).toBe("quote A");
  });

  it("drops relations without a sufficient quote (anti-hallucination)", () => {
    const result = resolveExtraction({
      entities: [
        { name: "RNN", type: "tech", description: "", quote: "" },
        { name: "LSTM", type: "tech", description: "", quote: "" },
      ],
      relations: [
        { src: "RNN", dst: "LSTM", relationType: "改进了", quote: "太短" },
        { src: "RNN", dst: "LSTM", relationType: "改进了", quote: "LSTM 对 RNN 的梯度问题做了改进" },
      ],
    });
    expect(result.relations).toHaveLength(1);
    expect(result.droppedRelations).toBe(1);
  });

  it("drops self-loops and unknown-endpoint-free relations create stubs", () => {
    const result = resolveExtraction({
      entities: [{ name: "A", type: "concept", description: "", quote: "" }],
      relations: [
        { src: "A", dst: "A", relationType: "关联", quote: "A 与 A 的自环应当被剔除" },
        { src: "A", dst: "B 未登记实体", relationType: "提到", quote: "这里提到了 B 未登记实体的内容" },
      ],
    });
    expect(result.droppedRelations).toBe(1);
    expect(result.relations).toHaveLength(1);
    // stub entity appended beyond the entity list
    expect(result.entities.some((e) => e.name === "B 未登记实体")).toBe(true);
    expect(result.entities.find((e) => e.name === "B 未登记实体")?.type).toBe("other");
  });

  it("caps entities and relations at the configured limits", () => {
    const entities = Array.from({ length: 50 }, (_, i) => ({
      name: `实体${i}`,
      type: "concept",
      description: "",
      quote: "",
    }));
    const relations = Array.from({ length: 60 }, (_, i) => ({
      src: "实体0",
      dst: `实体${i + 1}`,
      relationType: "关联",
      quote: `这是第 ${i} 条关系的原文引证内容`,
    }));
    const result = resolveExtraction({ entities, relations });
    expect(result.entities).toHaveLength(DEFAULT_MAX_ENTITIES);
    expect(result.relations).toHaveLength(DEFAULT_MAX_RELATIONS);
  });
});
