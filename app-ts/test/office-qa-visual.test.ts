import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandRequest, CommandResult, CommandRunner } from "../src/services/office-render/process.js";
import type { OfficeRenderPort, RenderedPage } from "../src/services/office-render/renderer.js";
import {
  VISUAL_EXIT,
  VisualRegressionUnavailableError,
  captureVisualSnapshot,
  diffSnapshots,
  normalizeSnapshot,
  runVisualRegression,
  serializeSnapshot,
  textSimilarity,
  type VisualSnapshot,
} from "../src/services/office/qa-visual.js";
import { runVisualRegressionCli } from "../scripts/office-visual-regression.js";

/**
 * Offline tests for the visual regression pipeline: no LibreOffice, no poppler.
 * A fake renderer returns fixed "PDF" bytes; a fake command runner returns
 * synthetic pdftotext -bbox-layout XHTML in the real poppler format.
 */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

interface FakeWord {
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function bboxXml(pages: FakeWord[][], pageWidth = 595.276, pageHeight = 841.89): string {
  const body = pages
    .map(
      (words) =>
        '<page width="' + pageWidth + '" height="' + pageHeight + '">' +
        words
          .map(
            (word) =>
              '<word xMin="' + word.x + '" yMin="' + word.y + '" xMax="' + (word.x + (word.width ?? 24)) +
              '" yMax="' + (word.y + (word.height ?? 11)) + '">' + word.text + "</word>",
          )
          .join("") +
        "</page>",
    )
    .join("");
  return '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body>' + body + "</body></html>";
}

class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  constructor(private xml: string, private result?: CommandResult) {}
  setXml(xml: string): void {
    this.xml = xml;
  }
  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (this.result) return this.result;
    return { code: 0, stdout: this.xml, stderr: "", timedOut: false };
  }
}

class FakeRenderer implements OfficeRenderPort {
  readonly available = true;
  constructor(private readonly pdf = PDF_BYTES) {}
  async render(): Promise<RenderedPage[]> {
    return [];
  }
  async convertToPdf(): Promise<{ data: Uint8Array; pageCount?: number }> {
    return { data: this.pdf, pageCount: 1 };
  }
}

class UnavailableFakeRenderer implements OfficeRenderPort {
  readonly available = false;
  readonly unavailableReason = "测试环境没有 LibreOffice";
  async render(): Promise<RenderedPage[]> {
    return [];
  }
}

class NoPdfFakeRenderer implements OfficeRenderPort {
  readonly available = true;
  async render(): Promise<RenderedPage[]> {
    return [];
  }
}

const SAMPLE_PAGES: FakeWord[][] = [
  [
    { text: "季度经营分析", x: 72.5, y: 96.2, width: 120, height: 22 },
    { text: "收入", x: 72.5, y: 140.8 },
  ],
  [{ text: "见表", x: 72.5, y: 96.1 }],
];

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-visual-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function docxFile(name: string): { fileName: string; bytes: Uint8Array } {
  return { fileName: name, bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) };
}

function sampleSnapshot(): VisualSnapshot {
  return normalizeSnapshot(
    SAMPLE_PAGES.map((words, index) => ({
      page: index + 1,
      widthPt: 595.276,
      heightPt: 841.89,
      words: words.map((word) => ({
        text: word.text,
        xMin: word.x,
        yMin: word.y,
        xMax: word.x + (word.width ?? 24),
        yMax: word.y + (word.height ?? 11),
      })),
    })),
  );
}

describe("normalizeSnapshot", () => {
  it("keeps text/coordinates/size and rounds to 0.1pt deterministically", () => {
    const snapshot = normalizeSnapshot([
      {
        page: 1,
        widthPt: 595.276,
        heightPt: 841.89,
        words: [
          { text: " 季度\n分析 ", xMin: 72.54, yMin: 96.25, xMax: 192.54, yMax: 118.25 },
        ],
      },
    ]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.pageSize).toEqual({ widthPt: 595.3, heightPt: 841.9 });
    expect(snapshot.pages[0]?.words).toEqual([{ text: "季度 分析", x: 72.5, y: 96.3, size: 22 }]);
  });

  it("serializes to stable JSON with a trailing newline", () => {
    const snapshot = sampleSnapshot();
    const serialized = serializeSnapshot(snapshot);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(snapshot);
    expect(serialized).toBe(serializeSnapshot(sampleSnapshot()));
  });
});

describe("diffSnapshots", () => {
  it("passes identical snapshots", () => {
    const diff = diffSnapshots(sampleSnapshot(), sampleSnapshot());
    expect(diff.pass).toBe(true);
    expect(diff.issues).toEqual([]);
    expect(diff.pageCount).toEqual({ expected: 2, actual: 2 });
  });

  it("fails on changed text", () => {
    const actual = sampleSnapshot();
    (actual.pages[0]?.words[1] as { text: string }).text = "成本";
    const diff = diffSnapshots(sampleSnapshot(), actual);
    expect(diff.pass).toBe(false);
    expect(diff.issues.join("\n")).toContain("文本不一致");
  });

  it("fails when a word drifts beyond the position tolerance", () => {
    const actual = sampleSnapshot();
    const word = actual.pages[0]?.words[0] as { x: number };
    word.x += 5;
    const diff = diffSnapshots(sampleSnapshot(), actual);
    expect(diff.pass).toBe(false);
    expect(diff.pages[0]?.positionDrifts).toBeGreaterThan(0);
    expect(diff.issues.join("\n")).toContain("位置偏移");
  });

  it("fails when the glyph height (size proxy) changes", () => {
    const actual = sampleSnapshot();
    (actual.pages[0]?.words[0] as { size: number }).size = 30;
    const diff = diffSnapshots(sampleSnapshot(), actual);
    expect(diff.pass).toBe(false);
    expect(diff.pages[0]?.sizeDrifts).toBeGreaterThan(0);
    expect(diff.issues.join("\n")).toContain("字号变化");
  });

  it("fails on page-count and page-size changes", () => {
    const shorter = sampleSnapshot();
    shorter.pages = shorter.pages.slice(0, 1);
    const diff = diffSnapshots(sampleSnapshot(), shorter);
    expect(diff.pass).toBe(false);
    expect(diff.issues.join("\n")).toContain("页数不一致");

    const taller = sampleSnapshot();
    (taller.pages[0] as { heightPt: number }).heightPt = 900;
    expect(diffSnapshots(sampleSnapshot(), taller).issues.join("\n")).toContain("页尺寸变化");
  });
});

describe("textSimilarity", () => {
  it("scores identical/near-identical text high and rewrites low", () => {
    expect(textSimilarity("见表 1", "见表 1")).toBe(1);
    expect(textSimilarity("季度经营分析", "季度经营分析报告")).toBeGreaterThan(0.8);
    expect(textSimilarity("完全不同的内容", "另一个主题")).toBeLessThan(0.5);
  });
});

describe("captureVisualSnapshot", () => {
  it("converts DOCX to PDF and parses pdftotext -bbox-layout", async () => {
    const runner = new FakeRunner(bboxXml(SAMPLE_PAGES));
    const snapshot = await captureVisualSnapshot(
      { renderer: new FakeRenderer(), runner, pdftotextPath: "pdftotext" },
      docxFile("报告.docx"),
    );
    expect(snapshot.pages).toHaveLength(2);
    expect(snapshot.pages[0]?.words[0]?.text).toBe("季度经营分析");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toContain("-bbox-layout");
    expect(runner.calls[0]?.args).toContain("-");
  });

  it("reports unavailable when the renderer is missing, cannot convert, or poppler fails", async () => {
    await expect(
      captureVisualSnapshot({ renderer: new UnavailableFakeRenderer(), runner: new FakeRunner("") }, docxFile("a.docx")),
    ).rejects.toBeInstanceOf(VisualRegressionUnavailableError);

    await expect(
      captureVisualSnapshot({ renderer: new NoPdfFakeRenderer(), runner: new FakeRunner("") }, docxFile("a.docx")),
    ).rejects.toBeInstanceOf(VisualRegressionUnavailableError);

    const failingRunner = new FakeRunner("", { code: 127, stdout: "", stderr: "pdftotext: not found", timedOut: false });
    await expect(
      captureVisualSnapshot(
        { renderer: new FakeRenderer(), runner: failingRunner, pdftotextPath: "pdftotext" },
        docxFile("a.docx"),
      ),
    ).rejects.toBeInstanceOf(VisualRegressionUnavailableError);

    const emptyRunner = new FakeRunner("<html><body></body></html>");
    await expect(
      captureVisualSnapshot(
        { renderer: new FakeRenderer(), runner: emptyRunner, pdftotextPath: "pdftotext" },
        docxFile("a.docx"),
      ),
    ).rejects.toBeInstanceOf(VisualRegressionUnavailableError);
  });
});

describe("runVisualRegression", () => {
  it("writes goldens with update and then compares cleanly", async () => {
    const goldenDir = path.join(await tempDir(), "golden");
    const runner = new FakeRunner(bboxXml(SAMPLE_PAGES));
    const deps = { renderer: new FakeRenderer(), runner, pdftotextPath: "pdftotext" };

    const created = await runVisualRegression({ cases: [docxFile("报告.docx")], goldenDir, update: true, deps });
    expect(created.exitCode).toBe(VISUAL_EXIT.ok);
    expect(created.results[0]?.status).toBe("created");
    const goldenPath = path.join(goldenDir, "报告.json");
    expect(created.results[0]?.goldenPath).toBe(goldenPath);
    const saved = JSON.parse(await fs.readFile(goldenPath, "utf8")) as VisualSnapshot;
    expect(saved.pages).toHaveLength(2);

    const compared = await runVisualRegression({ cases: [docxFile("报告.docx")], goldenDir, update: false, deps });
    expect(compared.exitCode).toBe(VISUAL_EXIT.ok);
    expect(compared.results[0]?.status).toBe("pass");
  });

  it("returns a diff when the rendering changed and 1 when a golden is missing", async () => {
    const goldenDir = path.join(await tempDir(), "golden");
    const runner = new FakeRunner(bboxXml(SAMPLE_PAGES));
    const deps = { renderer: new FakeRenderer(), runner, pdftotextPath: "pdftotext" };
    await runVisualRegression({ cases: [docxFile("报告.docx")], goldenDir, update: true, deps });

    runner.setXml(bboxXml([[...SAMPLE_PAGES[0] as FakeWord[], { text: "新增一行", x: 72.5, y: 300 }], SAMPLE_PAGES[1] as FakeWord[]]));
    const changed = await runVisualRegression({ cases: [docxFile("报告.docx")], goldenDir, update: false, deps });
    expect(changed.exitCode).toBe(VISUAL_EXIT.diff);
    expect(changed.results[0]?.status).toBe("fail");

    const missing = await runVisualRegression({ cases: [docxFile("新文件.docx")], goldenDir, update: false, deps });
    expect(missing.exitCode).toBe(VISUAL_EXIT.diff);
    expect(missing.results[0]?.status).toBe("missing");
  });

  it("propagates unavailable (no fake pass) when the renderer is missing", async () => {
    const goldenDir = path.join(await tempDir(), "golden");
    const result = await runVisualRegression({
      cases: [docxFile("报告.docx")],
      goldenDir,
      update: true,
      deps: { renderer: new UnavailableFakeRenderer(), runner: new FakeRunner("") },
    });
    expect(result.exitCode).toBe(VISUAL_EXIT.unavailable);
    expect(result.unavailableReason).toContain("LibreOffice");
    await expect(fs.access(path.join(goldenDir, "报告.json"))).rejects.toBeTruthy();
  });
});

describe("runVisualRegressionCli", () => {
  async function cliSetup() {
    const base = await tempDir();
    const dir = path.join(base, "docs");
    const golden = path.join(base, "golden");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "报告.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const runner = new FakeRunner(bboxXml(SAMPLE_PAGES));
    const lines: string[] = [];
    const deps = {
      renderer: new FakeRenderer(),
      runner,
      pdftotextPath: "pdftotext",
      cwd: base,
      write: (line: string) => lines.push(line),
      writeError: (line: string) => lines.push(line),
    };
    return { base, dir, golden, runner, lines, deps };
  }

  it("writes goldens with --update, then passes, then fails on change", async () => {
    const setup = await cliSetup();
    const update = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden", "--update"], setup.deps);
    expect(update).toBe(VISUAL_EXIT.ok);
    expect(setup.lines.join("\n")).toContain("GOLDEN");
    const goldenFile = path.join(setup.golden, "报告.json");
    expect(JSON.parse(await fs.readFile(goldenFile, "utf8")).pages).toHaveLength(2);

    setup.lines.length = 0;
    const pass = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden"], setup.deps);
    expect(pass).toBe(VISUAL_EXIT.ok);
    expect(setup.lines.join("\n")).toContain("[PASS] 报告.docx");

    setup.runner.setXml(bboxXml([[{ text: "改过的正文", x: 72.5, y: 96.2 }]]));
    setup.lines.length = 0;
    const diff = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden"], setup.deps);
    expect(diff).toBe(VISUAL_EXIT.diff);
    expect(setup.lines.join("\n")).toContain("[DIFF]");
  });

  it("exits 2 when the renderer or poppler is unavailable", async () => {
    const setup = await cliSetup();
    const noRenderer = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden"], {
      ...setup.deps,
      renderer: new UnavailableFakeRenderer(),
    });
    expect(noRenderer).toBe(VISUAL_EXIT.unavailable);
    expect(setup.lines.join("\n")).toContain("无法进行视觉回归");

    const noPoppler = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden"], {
      ...setup.deps,
      pdftotextPath: undefined,
      runner: new FakeRunner(""),
    });
    // No fake runner path here: real PATH lookup is used, so this environment
    // either has poppler (renders nothing => 2 from empty output) or not (2).
    expect(noPoppler).toBe(VISUAL_EXIT.unavailable);
  });

  it("exits 1 when the folder has no matching docx", async () => {
    const setup = await cliSetup();
    const code = await runVisualRegressionCli(["--dir", "docs", "--golden", "golden", "--file", "不存在"], setup.deps);
    expect(code).toBe(VISUAL_EXIT.diff);
  });
});
