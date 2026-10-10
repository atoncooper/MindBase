import { describe, it, expect } from "vitest";
import { SemanticChunker } from "../src/rag/chunking.js";

const paragraph = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}这是第${i}句测试内容，用于填充分块器的长度统计。`).join(" ");

describe("SemanticChunker", () => {
  it("短文本返回单 chunk", () => {
    const chunker = new SemanticChunker();
    const chunks = chunker.chunk("这是一个很短的测试文本。");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].displayText).toContain("测试文本");
  });

  it("空文本返回空数组", () => {
    expect(new SemanticChunker().chunk("")).toHaveLength(0);
  });

  it("长文本按 max_size 切分", () => {
    const chunker = new SemanticChunker({ targetSize: 100, minSize: 30, maxSize: 200, overlap: 20 });
    const text = paragraph(120, "A"); // Far beyond 200 characters
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.displayText.length).toBeLessThanOrEqual(400);
    }
  });

  it("embedding_text 带标题前缀且去重", () => {
    const chunker = new SemanticChunker();
    const chunks = chunker.chunk("正文内容。", "视频标题", "P1", null);
    expect(chunks[0].embeddingText.startsWith("P1 | 视频标题\n")).toBe(true);
  });

  it("标题行识别为 outline 内容类型", () => {
    const chunker = new SemanticChunker();
    const chunks = chunker.chunk("# 第一章\n\n第一章的具体内容，足够长。");
    expect(chunks[0].contentType).toBe("outline");
  });

  it("outline 边界切分", () => {
    const chunker = new SemanticChunker({ targetSize: 50, minSize: 10, maxSize: 90, overlap: 10 });
    const outline = "第一章 引言\n第二章 方法";
    const filler = "这一段是详细的阐述内容，用来把每个章节撑到超过目标块大小。".repeat(4);
    const text = `第一章 引言\n${filler}\n第二章 方法\n${filler}`;
    const chunks = chunker.chunk(text, "t", null, outline);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
