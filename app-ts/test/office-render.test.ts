import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandRequest, CommandResult, CommandRunner } from "../src/services/office-render/process.js";
import {
  OfficeRenderError,
  SofficeRenderer,
  createOfficeRenderer,
  resolveBinary,
} from "../src/services/office-render/renderer.js";

/**
 * Renderer pipeline (soffice -> pdf -> pdftoppm png) with a fake command runner:
 * the fake creates the exact files the real binaries would, so the whole path
 * (temp dir, arg construction, page selection, error mapping) is exercised
 * without LibreOffice in CI.
 */

interface FakeOptions {
  /** Skip writing the PDF (soffice silently failed). */
  noPdf?: boolean;
  /** Report a timeout instead of writing files. */
  timeout?: boolean;
  /** How many PNG pages pdftoppm produces (default 3). */
  pageCount?: number;
  pdfStderr?: string;
}

class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (this.options.timeout) return { code: null, stdout: "", stderr: "", timedOut: true };
    const isSoffice = request.command.includes("soffice");
    if (isSoffice) {
      if (!this.options.noPdf) {
        const outdirIndex = request.args.indexOf("--outdir");
        const outdir = request.args[outdirIndex + 1];
        await fs.writeFile(path.join(outdir, "source.pdf"), "pdf-bytes");
      }
      return { code: 0, stdout: "", stderr: this.options.pdfStderr ?? "", timedOut: false };
    }
    const prefix = request.args[request.args.length - 1];
    const pages = this.options.pageCount ?? 3;
    for (let page = 1; page <= pages; page += 1) {
      await fs.writeFile(prefix + "-" + page + ".png", "png-" + page);
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }
}

function rendererWith(runner: CommandRunner) {
  return new SofficeRenderer({
    runner,
    sofficePath: "/usr/bin/soffice",
    pdftoppmPath: "/usr/bin/pdftoppm",
    maxSourceBytes: 1024,
    defaultTimeoutMs: 10_000,
    defaultDpi: 96,
    defaultMaxPages: 2,
  });
}

describe("SofficeRenderer", () => {
  it("runs soffice then pdftoppm and returns page pngs", async () => {
    const runner = new FakeRunner({ pageCount: 3 });
    const pages = await rendererWith(runner).render({
      fileName: "demo.pptx",
      bytes: Buffer.from("pptx"),
    });
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(Buffer.from(pages[0].png).toString()).toBe("png-1");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].args).toContain("--convert-to");
    expect(runner.calls[0].args).toContain("pdf");
    expect(runner.calls[1].args).toContain("-png");
    // temp dir is cleaned up afterwards
    const outdir = runner.calls[0].args[runner.calls[0].args.indexOf("--outdir") + 1];
    await expect(fs.access(outdir)).rejects.toBeTruthy();
  });

  it("keeps only the requested page numbers", async () => {
    const runner = new FakeRunner({ pageCount: 4 });
    const pages = await rendererWith(runner).render({
      fileName: "demo.docx",
      bytes: Buffer.from("docx"),
      pages: [3],
    });
    expect(pages.map((page) => page.page)).toEqual([3]);
  });

  it("maps soffice failures and timeouts to domain errors", async () => {
    await expect(
      rendererWith(new FakeRunner({ noPdf: true, pdfStderr: "no filter" })).render({
        fileName: "a.xlsx",
        bytes: Buffer.from("xlsx"),
      }),
    ).rejects.toMatchObject({ code: "failed" });

    await expect(
      rendererWith(new FakeRunner({ timeout: true })).render({ fileName: "a.pptx", bytes: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects empty and oversized sources before spawning anything", async () => {
    const runner = new FakeRunner();
    const renderer = rendererWith(runner);
    await expect(renderer.render({ fileName: "a.pptx", bytes: new Uint8Array() })).rejects.toMatchObject({
      code: "failed",
    });
    await expect(
      renderer.render({ fileName: "a.pptx", bytes: Buffer.alloc(2048) }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("renderer availability", () => {
  it("explains why rendering is unavailable", async () => {
    const disabled = await createOfficeRenderer({
      runner: new FakeRunner(),
      enabled: false,
      sofficePath: "",
      pdftoppmPath: "",
      timeoutMs: 1000,
      dpi: 96,
      maxPages: 4,
      maxSourceBytes: 1024,
    });
    expect(disabled.available).toBe(false);
    expect(disabled.unavailableReason).toContain("OFFICERENDER__ENABLED");

    const missing = await createOfficeRenderer({
      runner: new FakeRunner(),
      enabled: true,
      sofficePath: path.join(os.tmpdir(), "definitely-missing-soffice"),
      pdftoppmPath: path.join(os.tmpdir(), "definitely-missing-pdftoppm"),
      timeoutMs: 1000,
      dpi: 96,
      maxPages: 4,
      maxSourceBytes: 1024,
    });
    expect(missing.available).toBe(false);
    expect(missing.unavailableReason).toContain("LibreOffice");
  });

  it("resolves an explicitly configured binary path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-bin-"));
    try {
      const bin = path.join(dir, "soffice");
      await fs.writeFile(bin, "#!/bin/sh\n", "utf8");
      expect(await resolveBinary(bin, "soffice")).toBe(bin);
      expect(await resolveBinary(path.join(dir, "nope"), "soffice")).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
