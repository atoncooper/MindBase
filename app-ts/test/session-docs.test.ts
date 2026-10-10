import { describe, it, expect } from "vitest";
import { parseDocument, UnsupportedDocumentError } from "../src/doc-parser/index.js";
import { MemorySessionDocumentStore } from "../src/repository/memory/session-docs.js";
import { buildSessionDocSection } from "../src/context/session-docs.js";

const DOC_TEXT = `# RAG 检索优化笔记

向量检索的质量取决于分块策略与召回参数。
over-recall 指先取回多于 top_k 的候选，再由 rerank 精排。
Milvus 的 nprobe 越大召回越全但延迟越高。

# 二、重排策略

gte-rerank-v2 是常用的中文精排模型，经网关透传调用。
`;

describe("parseDocument", () => {
  it("parses txt/md directly", async () => {
    const res = await parseDocument("notes.md", Buffer.from(DOC_TEXT, "utf-8"));
    expect(res.text).toContain("over-recall");
    expect(res.text).toContain("gte-rerank-v2");
  });

  it("strips html tags", async () => {
    const res = await parseDocument("page.html", Buffer.from("<html><body><h1>标题</h1><p>正文内容</p></body></html>"));
    expect(res.text).toContain("正文内容");
    expect(res.text).not.toContain("<p>");
  });

  it("image types route to OCR (disabled → OcrError); truly unknown types rejected", async () => {
    const { OcrError } = await import("../src/doc-parser/ocr.js");
    await expect(parseDocument("photo.jpg", Buffer.from("x"))).rejects.toBeInstanceOf(OcrError);
    await expect(parseDocument("file.xyz", Buffer.from("x"))).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });
});

describe("MemorySessionDocumentStore", () => {
  it("save → list scoped to session", async () => {
    const store = new MemorySessionDocumentStore();
    await store.save("s1", "a.md", ["chunk1", "chunk2"], 100);
    await store.save("s2", "b.md", ["other"], 50);
    const list = await store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("a.md");
    expect(list[0].chunkCount).toBe(2);
  });

  it("search never crosses sessions", async () => {
    const store = new MemorySessionDocumentStore();
    await store.save("s1", "a.md", ["Milvus nprobe 召回参数说明"], 100);
    await store.save("s2", "b.md", ["完全无关的另一个会话内容 gte-rerank"], 50);
    const hits = await store.search("s1", "nprobe 召回");
    expect(hits).toHaveLength(1);
    expect(hits[0].filename).toBe("a.md");
  });

  it("deleteBySession removes only that session's docs", async () => {
    const store = new MemorySessionDocumentStore();
    await store.save("s1", "a.md", ["x"], 1);
    await store.save("s2", "b.md", ["y"], 1);
    expect(await store.deleteBySession("s1")).toBe(1);
    expect(await store.list("s1")).toHaveLength(0);
    expect(await store.list("s2")).toHaveLength(1);
  });
});

describe("buildSessionDocSection", () => {
  it("returns empty string when no docs in session", async () => {
    const store = new MemorySessionDocumentStore();
    expect(await buildSessionDocSection(store, "s-empty", "任意问题")).toBe("");
    expect(await buildSessionDocSection(store, undefined, "任意问题")).toBe("");
  });

  it("renders doc list + relevant excerpts", async () => {
    const store = new MemorySessionDocumentStore();
    await store.save("s1", "rag-notes.md", ["over-recall 先取回多于 top_k 的候选再精排", "无关片段"], 200);
    const section = await buildSessionDocSection(store, "s1", "over-recall 是什么");
    expect(section).toContain("会话文档");
    expect(section).toContain("rag-notes.md");
    expect(section).toContain("over-recall");
    expect(section).not.toContain("无关片段"); // query-relevant excerpt only
  });
});
