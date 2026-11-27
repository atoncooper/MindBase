import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";

import type { CommandRequest, CommandResult, CommandRunner } from "../src/services/office-render/process.js";
import type { OfficeRenderPort, RenderedPage } from "../src/services/office-render/renderer.js";
import { OfficeRenderError, SofficeRenderer, UnavailableRenderer } from "../src/services/office-render/renderer.js";
import type { VisionReviewInput, VisionReviewPort } from "../src/services/office-render/vision.js";
import type { DocxAudit, OfficeQaAuditOptions, OfficeQaLimits } from "../src/services/office/qa.js";
import {
  OfficeQaService,
  parseBboxLayout,
  parsePdfImagesList,
  parsePdfInfo,
  parsePdfToHtml,
  renderAuditMarkdown,
  scoreFindings,
} from "../src/services/office/qa.js";

/**
 * Offline tests for the DOCX rendering QA pipeline: no LibreOffice, no poppler,
 * no network. A fake renderer returns "PDF" bytes; a fake command runner returns
 * fixed poppler output in the real formats; a fake vision port returns fixed text.
 */

const PAGE_W = 595.276;
const PAGE_H = 841.89;

// ───────────────────────────── fake poppler ─────────────────────────────

interface Outputs {
  pdfinfo: string;
  bbox: string;
  pdftohtml: string;
  pdfimages: string;
  /** false = pdftoppm fails (page rendering degradation path). */
  pdftoppm?: boolean;
  /** Overrides: make one poppler command fail. */
  fail?: "pdfinfo" | "pdftotext" | "pdftohtml" | "pdfimages";
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function failed(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr, timedOut: false };
}

class FakePopplerRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];

  constructor(private readonly outputs: Outputs) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    const name = request.command.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (this.outputs.fail === name) return failed(name + ": simulated failure");
    switch (name) {
      case "pdfinfo":
        return ok(this.outputs.pdfinfo);
      case "pdftotext":
        return ok(this.outputs.bbox);
      case "pdftohtml":
        return ok(this.outputs.pdftohtml);
      case "pdfimages":
        return ok(this.outputs.pdfimages);
      case "pdftoppm": {
        if (this.outputs.pdftoppm === false) return failed("pdftoppm: cannot write output");
        const prefix = request.args[request.args.length - 1];
        await fs.writeFile(prefix + "-1.png", "png-1");
        await fs.writeFile(prefix + "-2.png", "png-2");
        return ok("");
      }
      default:
        return failed("unknown command " + request.command);
    }
  }
}

// ───────────────────────────── fake renderer / vision ─────────────────────────────

class FakePdfRenderer implements OfficeRenderPort {
  readonly available = true;

  constructor(private readonly pdf = "%PDF-1.4\n/Type /Page\n/Type /Page\n") {}

  async render(): Promise<RenderedPage[]> {
    return [];
  }

  async convertToPdf(): Promise<{ data: Uint8Array; pageCount?: number }> {
    return { data: new Uint8Array(Buffer.from(this.pdf)), pageCount: 2 };
  }
}

/** Renderer without the optional PDF conversion (older stub) -> QA unavailable. */
class RenderOnlyRenderer implements OfficeRenderPort {
  readonly available = true;

  async render(): Promise<RenderedPage[]> {
    return [];
  }
}

class ThrowingPdfRenderer implements OfficeRenderPort {
  readonly available = true;

  async render(): Promise<RenderedPage[]> {
    return [];
  }

  async convertToPdf(): Promise<{ data: Uint8Array; pageCount?: number }> {
    throw new OfficeRenderError("failed", "soffice 崩溃");
  }
}

class FakeVision implements VisionReviewPort {
  readonly enabled = true;
  readonly model = "fake-vision";
  calls = 0;

  async review(input: VisionReviewInput): Promise<string> {
    this.calls += 1;
    expect(input.images.length).toBeGreaterThan(0);
    return "第 3 页存在标题孤行，建议调整分页";
  }
}

// ───────────────────────────── poppler output builders ─────────────────────────────

function word(text: string, x: number, y: number, width = 60, height = 12): string {
  return (
    '<word xMin="' +
    x.toFixed(3) +
    '" yMin="' +
    y.toFixed(3) +
    '" xMax="' +
    (x + width).toFixed(3) +
    '" yMax="' +
    (y + height).toFixed(3) +
    '">' +
    text +
    "</word>"
  );
}

interface BboxPageSpec {
  page: number;
  header?: string | null;
  footer?: string | null;
  body?: string[];
  widthPt?: number;
  heightPt?: number;
  extraWords?: string[];
}

function bboxDocument(pages: BboxPageSpec[]): string {
  const chunks: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<html xmlns="http://www.w3.org/1999/xhtml"><body><doc>'];
  for (const page of pages) {
    const width = page.widthPt ?? PAGE_W;
    const height = page.heightPt ?? PAGE_H;
    const words: string[] = [];
    if (page.header !== null) words.push(word(page.header ?? "MindBase", 60, 20, 80));
    const body = page.body ?? ["正文内容示例", "第二行正文"];
    body.forEach((line, index) => words.push(word(line, 60, 100 + index * 30, 120)));
    if (page.footer !== null) words.push(word(page.footer ?? "第 " + page.page + " 页", 60, 810, 60));
    for (const extra of page.extraWords ?? []) words.push(extra);
    chunks.push('<page width="' + width.toFixed(3) + '" height="' + height.toFixed(3) + '">' + words.join("") + "</page>");
  }
  chunks.push("</doc></body></html>");
  return chunks.join("");
}

function defaultBboxPages(): BboxPageSpec[] {
  return [
    { page: 1, header: null, footer: null, body: ["技术方案"] },
    { page: 2, body: ["目录", "1 概述 ...... 3", "2 方案 ...... 5"] },
    { page: 3 },
    { page: 4 },
  ];
}

interface RunSpec {
  text: string;
  size: number;
  family: string;
}

function fontDocument(pages: Array<{ page: number; runs: RunSpec[] }>): string {
  const chunks: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<pdf2xml producer="poppler" version="23.08.0">'];
  for (const page of pages) {
    const specs = new Map<string, number>();
    const fontspecs: string[] = [];
    for (const run of page.runs) {
      const key = run.size + "|" + run.family;
      if (!specs.has(key)) {
        const id = specs.size;
        specs.set(key, id);
        fontspecs.push('<fontspec id="' + id + '" size="' + run.size + '" family="' + run.family + '" color="#000000"/>');
      }
    }
    const texts = page.runs.map((run, index) => {
      const id = specs.get(run.size + "|" + run.family);
      return '<text top="' + (100 + index * 20) + '" left="60" width="300" height="18" font="' + id + '">' + run.text + "</text>";
    });
    chunks.push('<page number="' + page.page + '" position="absolute" top="0" left="0" height="1263" width="893">' + fontspecs.join("") + texts.join("") + "</page>");
  }
  chunks.push("</pdf2xml>");
  return chunks.join("");
}

function defaultFontPages(): Array<{ page: number; runs: RunSpec[] }> {
  return [
    { page: 1, runs: [{ text: "技术方案", size: 22, family: "SimHei" }] },
    {
      page: 2,
      runs: [
        { text: "目录", size: 16, family: "SimHei" },
        { text: "1 概述", size: 16, family: "SimHei" },
        { text: "1.1 背景", size: 13, family: "SimHei" },
      ],
    },
    {
      page: 3,
      runs: [
        { text: "2 方案", size: 16, family: "SimHei" },
        { text: "正文内容示例", size: 10.5, family: "SimSun" },
        { text: "第二行正文", size: 10.5, family: "SimSun" },
      ],
    },
    {
      page: 4,
      runs: [
        { text: "正文内容示例", size: 10.5, family: "SimSun" },
        { text: "第二行正文", size: 10.5, family: "SimSun" },
        { text: "第三行正文", size: 10.5, family: "SimSun" },
      ],
    },
  ];
}

function imagesList(rows: Array<{ page: number; width: number; height: number; xppi: number; yppi: number }>): string {
  const header =
    "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n" +
    "--------------------------------------------------------------------------------------------\n";
  return (
    header +
    rows
      .map(
        (row, index) =>
          "   " +
          row.page +
          "     " +
          index +
          " image   " +
          row.width +
          " " +
          row.height +
          " rgb     3   8  jpeg   no        12 0   " +
          row.xppi +
          "   " +
          row.yppi +
          " 100K  10%\n",
      )
      .join("")
  );
}

function defaultOutputs(overrides: Partial<Outputs> = {}): Outputs {
  return {
    pdfinfo: "Title:           Demo\nPages:           4\nPage size:       595.276 x 841.89 pts (A4)\n",
    bbox: bboxDocument(defaultBboxPages()),
    pdftohtml: fontDocument(defaultFontPages()),
    pdfimages: imagesList([{ page: 1, width: 800, height: 600, xppi: 150, yppi: 150 }]),
    ...overrides,
  };
}

// ───────────────────────────── audit helper ─────────────────────────────

async function auditWith(
  outputs: Outputs,
  options: {
    renderer?: OfficeRenderPort;
    vision?: VisionReviewPort;
    audit?: OfficeQaAuditOptions;
    limits?: OfficeQaLimits;
  } = {},
): Promise<{ audit: DocxAudit; runner: FakePopplerRunner }> {
  const runner = new FakePopplerRunner(outputs);
  const qa = new OfficeQaService({
    renderer: options.renderer ?? new FakePdfRenderer(),
    runner,
    ...(options.vision ? { vision: options.vision } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const audit = await qa.audit({ fileName: "demo.docx", bytes: new Uint8Array([1, 2, 3]) }, options.audit);
  return { audit, runner };
}

// ───────────────────────────── tests ─────────────────────────────

describe("OfficeQaService audit", () => {
  it("正常文档得到高分且全部检查通过", async () => {
    const { audit, runner } = await auditWith(defaultOutputs());
    expect(audit.available).toBe(true);
    expect(audit.pageCount).toBe(4);
    expect(audit.pageSize.widthPt).toBeCloseTo(PAGE_W, 2);
    expect(audit.pageSize.heightPt).toBeCloseTo(PAGE_H, 2);
    expect(audit.findings).toEqual([]);
    expect(audit.score).toBe(100);
    expect(audit.checks.length).toBeGreaterThanOrEqual(9);
    expect(audit.checks.every((check) => check.ok)).toBe(true);
    // pdfinfo / pdftotext / pdftohtml / pdfimages are all invoked
    const commands = runner.calls.map((call) => call.command);
    expect(commands).toContain("pdfinfo");
    expect(commands).toContain("pdftotext");
    expect(commands).toContain("pdftohtml");
    expect(commands).toContain("pdfimages");
  });

  it("文本越界报 error 并扣分", async () => {
    const pages = defaultBboxPages();
    pages[2].extraWords = [word("严重溢出版心的文本", 5, 300, 200)];
    const { audit } = await auditWith(defaultOutputs({ bbox: bboxDocument(pages) }));
    const finding = audit.findings.find((item) => item.code === "text-overflow");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.page).toBe(3);
    expect(audit.score).toBe(100 - 12);
    expect(audit.checks.find((check) => check.name === "文本越界")?.ok).toBe(false);
  });

  it("内容过少的非封面页报空白页 warning", async () => {
    const pages = defaultBboxPages();
    pages[2] = { page: 3, header: "页眉", footer: "第 3 页", body: [] };
    const { audit } = await auditWith(defaultOutputs({ bbox: bboxDocument(pages) }));
    const finding = audit.findings.find((item) => item.code === "blank-page");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.page).toBe(3);
    // 封面页（第 1 页）内容少不算空白页
    expect(audit.findings.filter((item) => item.code === "blank-page")).toHaveLength(1);
  });

  it("缺少页脚报 header-footer warning", async () => {
    const pages = defaultBboxPages();
    pages[2].footer = null;
    const { audit } = await auditWith(defaultOutputs({ bbox: bboxDocument(pages) }));
    const finding = audit.findings.find((item) => item.code === "header-footer");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("页脚");
    expect(audit.checks.find((check) => check.name === "页眉页脚")?.ok).toBe(false);
  });

  it("标题字号倒挂报 heading-order error", async () => {
    const fontPages = defaultFontPages();
    fontPages[2].runs = [
      { text: "1 引言", size: 16, family: "SimHei" },
      { text: "1.1 背景", size: 20, family: "SimHei" },
      { text: "正文内容示例", size: 10.5, family: "SimSun" },
      { text: "第二行正文", size: 10.5, family: "SimSun" },
      { text: "第三行正文", size: 10.5, family: "SimSun" },
    ];
    const { audit } = await auditWith(defaultOutputs({ pdftohtml: fontDocument(fontPages) }));
    const finding = audit.findings.find((item) => item.code === "heading-order");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(audit.checks.find((check) => check.name === "标题层级")?.ok).toBe(false);
  });

  it("页面尺寸不一致报 page-size warning", async () => {
    const pages = defaultBboxPages();
    pages[2].widthPt = PAGE_H;
    pages[2].heightPt = PAGE_W;
    const { audit } = await auditWith(defaultOutputs({ bbox: bboxDocument(pages) }));
    const finding = audit.findings.find((item) => item.code === "page-size");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.page).toBe(3);
    expect(audit.checks.find((check) => check.name === "页面尺寸")?.ok).toBe(false);
  });

  it("渲染页面图并做视觉复核", async () => {
    const vision = new FakeVision();
    const { audit } = await auditWith(defaultOutputs(), {
      vision,
      audit: { renderPages: true, vision: true, maxPages: 2 },
    });
    expect(audit.renderedPages?.map((page) => page.page)).toEqual([1, 2]);
    expect(Buffer.from(audit.renderedPages?.[0].png ?? []).toString()).toBe("png-1");
    expect(vision.calls).toBe(1);
    const finding = audit.findings.find((item) => item.code === "vision");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("标题孤行");
    expect(audit.checks.find((check) => check.name === "视觉复核")?.ok).toBe(false);
  });

  it("未配置视觉模型时只记 info，不算失败", async () => {
    const { audit } = await auditWith(defaultOutputs(), { audit: { renderPages: true, vision: true } });
    const finding = audit.findings.find((item) => item.code === "vision");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("未启用");
    expect(audit.score).toBe(99);
    expect(audit.checks.find((check) => check.name === "视觉复核")?.ok).toBe(true);
  });

  it("pdftoppm 失败时降级为 info 且不抛异常", async () => {
    const { audit } = await auditWith(defaultOutputs({ pdftoppm: false }), { audit: { renderPages: true } });
    expect(audit.available).toBe(true);
    expect(audit.renderedPages).toBeUndefined();
    expect(audit.findings.find((item) => item.code === "render-pages")?.severity).toBe("info");
  });
});

describe("OfficeQaService availability", () => {
  it("renderer 不可用时返回 available:false + 中文原因，不抛异常", async () => {
    const qa = new OfficeQaService({ renderer: new UnavailableRenderer("未找到 LibreOffice（soffice），无法渲染") });
    const audit = await qa.audit({ fileName: "demo.docx", bytes: new Uint8Array([1]) });
    expect(audit.available).toBe(false);
    expect(audit.reason).toContain("LibreOffice");
    expect(audit.findings).toEqual([]);
    expect(audit.score).toBe(0);
    expect(audit.checks[0].ok).toBe(false);
    expect(renderAuditMarkdown(audit)).toContain("不可用");
  });

  it("渲染器未实现 convertToPdf 时明确不可用", async () => {
    const qa = new OfficeQaService({ renderer: new RenderOnlyRenderer() });
    const audit = await qa.audit({ fileName: "demo.docx", bytes: new Uint8Array([1]) });
    expect(audit.available).toBe(false);
    expect(audit.reason).toContain("不支持 DOCX→PDF");
  });

  it("DOCX 转 PDF 失败时返回 available:false 而不是伪造分数", async () => {
    const qa = new OfficeQaService({ renderer: new ThrowingPdfRenderer() });
    const audit = await qa.audit({ fileName: "demo.docx", bytes: new Uint8Array([1]) });
    expect(audit.available).toBe(false);
    expect(audit.reason).toContain("DOCX 转 PDF 失败");
    expect(audit.reason).toContain("soffice 崩溃");
  });

  it("缺少 poppler 时明确不可用", async () => {
    const { audit } = await auditWith(defaultOutputs({ fail: "pdftotext" }));
    expect(audit.available).toBe(false);
    expect(audit.reason).toContain("pdftotext");
    expect(audit.score).toBe(0);
  });
});

describe("poppler parsers", () => {
  it("解析 pdfinfo / bbox / pdftohtml / pdfimages 输出", () => {
    const info = parsePdfInfo("Pages:           7\nPage size:       612 x 792 pts (letter)\n");
    expect(info.pageCount).toBe(7);
    expect(info.pageSize).toEqual({ widthPt: 612, heightPt: 792 });

    const pages = parseBboxLayout(bboxDocument(defaultBboxPages()));
    expect(pages).toHaveLength(4);
    expect(pages[0].widthPt).toBeCloseTo(PAGE_W, 2);
    expect(pages[1].words.map((item) => item.text)).toContain("目录");

    const fonts = parsePdfToHtml(fontDocument(defaultFontPages()));
    expect(fonts).toHaveLength(4);
    const heading = fonts[1].textRuns.find((run) => run.text === "1 概述");
    expect(heading?.fontSizePt).toBe(16);
    expect(heading?.fontFamily).toBe("SimHei");

    const images = parsePdfImagesList(imagesList([{ page: 2, width: 1024, height: 512, xppi: 200, yppi: 200 }]));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ page: 2, width: 1024, height: 512, xPpi: 200, yPpi: 200 });
  });
});

describe("renderAuditMarkdown", () => {
  it("输出可用文档的中文报告（结论/检查项/问题清单）", async () => {
    const { audit } = await auditWith(defaultOutputs());
    const markdown = renderAuditMarkdown(audit);
    expect(markdown).toContain("# 文档质检报告");
    expect(markdown).toContain("结论：良好");
    expect(markdown).toContain("100/100");
    expect(markdown).toContain("## 检查项");
    expect(markdown).toContain("## 问题清单");
    expect(markdown).toContain("未发现问题");
    expect(markdown).toContain("A4 纵向");
  });

  it("输出不可用文档的明确说明", () => {
    const audit: DocxAudit = {
      available: false,
      reason: "未找到 LibreOffice（soffice）",
      pageCount: 0,
      pageSize: { widthPt: 0, heightPt: 0 },
      findings: [],
      checks: [{ name: "渲染可用", ok: false, detail: "未找到 LibreOffice（soffice）" }],
      score: 0,
    };
    const markdown = renderAuditMarkdown(audit);
    expect(markdown).toContain("不可用");
    expect(markdown).toContain("未执行任何版式检查");
    expect(markdown).toContain("LibreOffice");
  });

  it("score 下限为 0", () => {
    expect(scoreFindings([])).toBe(100);
    expect(
      scoreFindings(
        Array.from({ length: 20 }, (_, index) => ({
          code: "e" + index,
          severity: "error" as const,
          message: "boom",
        })),
      ),
    ).toBe(0);
  });
});
// ───────────────────────────── renderer convertToPdf ─────────────────────────────

/** Fake soffice: writes the PDF the converter expects, like the real binary. */
class FakeSofficeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];

  constructor(private readonly pdf = "%PDF-1.4\n/Type /Page\n/Type /Page\n") {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (request.command !== "/usr/bin/soffice") return failed("unexpected command " + request.command);
    const outdir = request.args[request.args.indexOf("--outdir") + 1];
    await fs.writeFile(outdir + "/source.pdf", this.pdf);
    return ok("");
  }
}

describe("SofficeRenderer.convertToPdf", () => {
  it("调用 soffice --headless --convert-to pdf 并返回 PDF 字节", async () => {
    const runner = new FakeSofficeRunner();
    const renderer = new SofficeRenderer({
      runner,
      sofficePath: "/usr/bin/soffice",
      pdftoppmPath: "/usr/bin/pdftoppm",
      maxSourceBytes: 1024,
      defaultTimeoutMs: 10_000,
      defaultDpi: 96,
      defaultMaxPages: 2,
    });
    const conversion = await renderer.convertToPdf({ fileName: "demo.docx", bytes: new Uint8Array([1, 2, 3]) });
    expect(Buffer.from(conversion.data).toString()).toContain("%PDF-1.4");
    expect(conversion.pageCount).toBe(2);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toContain("--convert-to");
    expect(runner.calls[0].args).toContain("pdf");
    // temp dir cleaned up afterwards
    const outdir = runner.calls[0].args[runner.calls[0].args.indexOf("--outdir") + 1];
    await expect(fs.access(outdir)).rejects.toBeTruthy();
  });
});
