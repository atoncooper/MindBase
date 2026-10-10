import { describe, it, expect } from "vitest";
import {
  collectChunks,
  folderTypeDistribution,
} from "../src/services/quiz-generation.js";
import type { Document } from "../src/rag/types.js";

/**
 * Source-mode quiz helpers: folder type distribution and the raw-retrieval →
 * quiz-chunk collector (dedupe, min length, page post-filter, target cap).
 */

function doc(partial: {
  bvid?: string;
  pageIndex?: number;
  chunkIndex?: number;
  chunkId?: string;
  text: string;
  title?: string;
}): Document {
  return {
    text: partial.text,
    metadata: {
      bvid: partial.bvid,
      pageIndex: partial.pageIndex,
      chunkIndex: partial.chunkIndex,
      chunkId: partial.chunkId ?? ((partial.bvid ?? "x") + ":" + (partial.chunkIndex ?? 0)),
      title: partial.title,
    },
  };
}

describe("folderTypeDistribution", () => {
  it("sums to the requested count", () => {
    for (const count of [1, 5, 10, 50]) {
      const dist = folderTypeDistribution(count);
      expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBe(count);
    }
  });

  it("matches the Python formula for 10 questions", () => {
    // single max(2,3)=3, multi max(1,2)=2, short max(1,2)=2, essay max(1,2)=2 => 9, single += 1
    expect(folderTypeDistribution(10)).toEqual({
      single_choice: 4,
      multi_choice: 2,
      short_answer: 2,
      essay: 2,
    });
  });
});

describe("collectChunks", () => {
  const long = "内容".repeat(60); // 120 chars

  it("dedupes by chunk id and drops short fragments", () => {
    const seen = new Set<string>();
    const out = collectChunks(
      [
        doc({ bvid: "BV1", chunkIndex: 0, text: long }),
        doc({ bvid: "BV1", chunkIndex: 0, text: long }),
        doc({ bvid: "BV1", chunkIndex: 1, text: "太短" }),
      ],
      seen,
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0].bvid).toBe("BV1");
    expect(out[0].content.length).toBeLessThanOrEqual(3000);
  });

  it("post-filters to the requested pages and carries the page title", () => {
    const seen = new Set<string>();
    const lookup = new Map<string, string>([["BV1:1", "第二P"]]);
    const out = collectChunks(
      [
        doc({ bvid: "BV1", pageIndex: 0, chunkIndex: 0, text: long }),
        doc({ bvid: "BV1", pageIndex: 1, chunkIndex: 1, text: long }),
      ],
      seen,
      10,
      lookup,
    );
    expect(out).toHaveLength(1);
    expect(out[0].pageIndex).toBe(1);
    expect(out[0].pageTitle).toBe("第二P");
  });

  it("stops at the target across batches", () => {
    const seen = new Set<string>();
    let out = collectChunks([doc({ bvid: "BV1", chunkIndex: 0, text: long })], seen, 2);
    out = collectChunks([doc({ bvid: "BV1", chunkIndex: 1, text: long })], seen, 2, undefined, out);
    out = collectChunks([doc({ bvid: "BV1", chunkIndex: 2, text: long })], seen, 2, undefined, out);
    expect(out).toHaveLength(2);
  });
});
