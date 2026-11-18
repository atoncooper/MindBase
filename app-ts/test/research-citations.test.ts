import { describe, expect, it } from "vitest";
import { parseCitationKeys } from "../src/services/research/research-citations.js";

/**
 * Shared citation parser (v1.1): LaTeX, Pandoc and legacy bare-bracket syntax
 * plus false-positive protection. Pure function — no mocks, no I/O.
 */

describe("parseCitationKeys: LaTeX commands", () => {
 it("reads comma-separated keys from \\cite", () => {
    expect(parseCitationKeys("已有工作见 \\cite{zhang2024,li2023}。")).toEqual(["zhang2024", "li2023"]);
  });

 it("reads \\citep and \\citet keys", () => {
    expect(parseCitationKeys("\\citep{smith2019}")).toEqual(["smith2019"]);
    expect(parseCitationKeys("\\citet{doe2020} 指出")).toEqual(["doe2020"]);
  });

 it("skips LaTeX optional arguments before the key list", () => {
    expect(parseCitationKeys("\\citep[see][p.3]{doe2020}")).toEqual(["doe2020"]);
  });

 it("trims whitespace around LaTeX keys", () => {
    expect(parseCitationKeys("\\cite{ zhang2024 , li2023 }")).toEqual(["zhang2024", "li2023"]);
  });
});

describe("parseCitationKeys: Pandoc citations", () => {
 it("reads a single [@key]", () => {
    expect(parseCitationKeys("如 [@a] 所述。")).toEqual(["a"]);
  });

 it("treats the comma part as a locator, not another key", () => {
    expect(parseCitationKeys("[@doe2020, p.3]")).toEqual(["doe2020"]);
    expect(parseCitationKeys("[@doe2020, pp. 33-35; @roe2021]")).toEqual(["doe2020", "roe2021"]);
  });

 it("reads multiple citations separated by semicolons", () => {
    expect(parseCitationKeys("[@a; @b]")).toEqual(["a", "b"]);
  });

 it("supports prose prefixes and author-suppression markers", () => {
    expect(parseCitationKeys("[see @a; -@b]")).toEqual(["a", "b"]);
  });
});

describe("parseCitationKeys: legacy bare brackets", () => {
 it("reads a single legacy key", () => {
    expect(parseCitationKeys("前人研究 [zhang2024] 表明。")).toEqual(["zhang2024"]);
  });

 it("reads comma-separated legacy keys", () => {
    expect(parseCitationKeys("[zhang2024, li2023]")).toEqual(["zhang2024", "li2023"]);
  });

 it("trims whitespace inside a legacy group", () => {
    expect(parseCitationKeys("[ zhang2024 ]")).toEqual(["zhang2024"]);
  });
});

describe("parseCitationKeys: false-positive protection", () => {
 it("ignores numeric and brief CJK brackets", () => {
    expect(parseCitationKeys("见 [1]、[图1]、[注]、[2024]。")).toEqual([]);
  });

 it("ignores [[run:<id>]] evidence references", () => {
    expect(parseCitationKeys("准确率 0.92 [[run:r1]]。")).toEqual([]);
  });

 it("ignores markdown link labels", () => {
    expect(parseCitationKeys("见 [paper](https://example.com/paper.pdf)。")).toEqual([]);
  });

 it("ignores e-mail addresses inside brackets", () => {
    expect(parseCitationKeys("[联系 user@example.com]")).toEqual([]);
  });

 it("returns [] for text without citations", () => {
    expect(parseCitationKeys("")).toEqual([]);
    expect(parseCitationKeys("没有任何引用的正文 42%。")).toEqual([]);
  });
});

describe("parseCitationKeys: ordering and dedupe", () => {
 it("keeps first-appearance order across dialects", () => {
    expect(parseCitationKeys("\\cite{b}，[@a]，[chen2020]")).toEqual(["b", "a", "chen2020"]);
  });

 it("deduplicates keys repeated across dialects", () => {
    expect(parseCitationKeys("\\cite{zhang2024} 和 [@zhang2024] 以及 [zhang2024]")).toEqual([
      "zhang2024",
    ]);
  });
});
