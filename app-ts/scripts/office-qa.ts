/**
 * DOCX layout QA CLI: every .docx in a folder -> LibreOffice -> PDF ->
 * poppler (pdfinfo / pdftotext -bbox-layout / pdftohtml -xml / pdfimages /
 * pdftoppm) -> deterministic checks (+ optional vision review) -> markdown/JSON.
 *
 * Usage:
 *   npm run qa:office -- [--dir <folder>] [--pages N] [--vision]
 *
 *   --dir     folder containing .docx files (default: app-ts/qa-output)
 *   --pages   rasterize the first N pages for the report (also enables --vision)
 *   --vision  ask the configured vision model to review the rendered pages
 *
 * Outputs:
 *   <dir>/reports/<name>.md   one Chinese report per document
 *   <dir>/report.md           summary report
 *   <dir>/report.json         structured summary (no page images)
 *
 * Exit codes:
 *   0 = audits ran (findings may exist)
 *   1 = some documents could not be audited / no .docx found
 *   2 = the audit environment is unavailable (no LibreOffice or poppler) — never
 *       a fake success
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { config } from "../src/config/index.js";
import { createLogger } from "../src/logger.js";
import { NodeCommandRunner } from "../src/services/office-render/process.js";
import { createOfficeRenderer, resolveBinary } from "../src/services/office-render/renderer.js";
import type { OfficeQaBinaries, DocxAudit } from "../src/services/office/qa.js";
import { OfficeQaService, renderAuditMarkdown } from "../src/services/office/qa.js";
import { GatewayVisionReview } from "../src/services/office-render/vision.js";
import type { VisionReviewPort } from "../src/services/office-render/vision.js";

const log = createLogger("OFFICE-QA-CLI");

interface QaRecord {
  fileName: string;
  report: string;
  audit: DocxAudit;
}

function argValue(flag: string): string | undefined {
  const eqPrefix = flag + "=";
  const eqArg = process.argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqArg) return eqArg.slice(eqPrefix.length);
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

function safeReportName(fileName: string): string {
  return fileName.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]/g, "_") + ".md";
}

function printUnavailable(reason: string): void {
  process.stderr.write("\n");
  process.stderr.write("无法进行 DOCX 版面质检：" + reason + "\n");
  process.stderr.write("需要 LibreOffice（soffice）与 poppler-utils（pdfinfo / pdftotext / pdftohtml / pdfimages / pdftoppm）。\n");
  process.stderr.write("请安装后重试；本脚本在缺少依赖时不会输出任何伪造的检查结果。\n");
}

async function resolvePopplerBinaries(): Promise<{ binaries: OfficeQaBinaries; missing: string[] }> {
  const binaries: OfficeQaBinaries = {};
  const missing: string[] = [];
  const names = ["pdfinfo", "pdftotext", "pdftohtml", "pdfimages"] as const;
  for (const name of names) {
    const resolved = await resolveBinary("", name);
    if (resolved) binaries[name] = resolved;
    else missing.push(name);
  }
  const pdftoppm = await resolveBinary(config.officeRender.pdftoppmPath, "pdftoppm");
  if (pdftoppm) binaries.pdftoppm = pdftoppm;
  else missing.push("pdftoppm");
  return { binaries, missing };
}

function countSeverity(audit: DocxAudit, severity: "error" | "warning" | "info"): number {
  return audit.findings.filter((finding) => finding.severity === severity).length;
}

function buildSummary(records: QaRecord[], outputDir: string, maxPages: number, vision: boolean): string {
  const available = records.filter((record) => record.audit.available);
  const averageScore =
    available.length > 0
      ? Math.round(available.reduce((sum, record) => sum + record.audit.score, 0) / available.length)
      : 0;
  const lines: string[] = [];
  lines.push("# DOCX 版面质检汇总");
  lines.push("");
  lines.push("- 生成时间：" + new Date().toISOString());
  lines.push("- 目录：" + outputDir);
  lines.push("- 文档数：" + records.length + "（可用 " + available.length + " / 不可用 " + (records.length - available.length) + "）");
  lines.push("- 平均分：" + averageScore + "/100（仅统计可用文档）");
  lines.push("- 跨页渲染：" + (maxPages > 0 ? "前 " + maxPages + " 页" : "未启用"));
  lines.push("- 视觉复核：" + (vision ? "已请求（未配置视觉模型时自动跳过）" : "未启用"));
  lines.push("");
  lines.push("| 文件 | 可用 | 页数 | 分数 | 错误 | 警告 | 提示 | 报告 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const record of records) {
    const audit = record.audit;
    const reportLink = "[打开](reports/" + encodeURIComponent(record.report) + ")";
    lines.push(
      "| " +
        record.fileName.replace(/\|/g, "\\|") +
        " | " +
        (audit.available ? "是" : "否") +
        " | " +
        (audit.available ? String(audit.pageCount) : "-") +
        " | " +
        (audit.available ? String(audit.score) : "-") +
        " | " +
        (audit.available ? String(countSeverity(audit, "error")) : "-") +
        " | " +
        (audit.available ? String(countSeverity(audit, "warning")) : "-") +
        " | " +
        (audit.available ? String(countSeverity(audit, "info")) : "-") +
        " | " +
        reportLink +
        " |",
    );
  }
  lines.push("");
  const unavailable = records.filter((record) => !record.audit.available);
  if (unavailable.length > 0) {
    lines.push("## 不可用说明");
    lines.push("");
    for (const record of unavailable) {
      lines.push("- " + record.fileName + "：" + (record.audit.reason ?? "未知原因"));
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<number> {
  const outputDir = path.resolve(argValue("--dir") ?? "qa-output");
  const pagesRaw = argValue("--pages");
  const maxPages = pagesRaw ? Number.parseInt(pagesRaw, 10) || 0 : 0;
  const vision = process.argv.includes("--vision");

  const runner = new NodeCommandRunner();
  const renderer = await createOfficeRenderer({
    runner,
    enabled: config.officeRender.enabled,
    sofficePath: config.officeRender.sofficePath,
    pdftoppmPath: config.officeRender.pdftoppmPath,
    timeoutMs: config.officeRender.timeoutMs,
    dpi: config.officeRender.dpi,
    maxPages: config.officeRender.maxPages,
    maxSourceBytes: config.officeExport.maxBytes,
  });
  if (!renderer.available || typeof renderer.convertToPdf !== "function") {
    printUnavailable(renderer.unavailableReason ?? "当前渲染器不支持 DOCX→PDF 转换");
    return 2;
  }

  const poppler = await resolvePopplerBinaries();
  if (poppler.missing.length > 0) {
    printUnavailable("缺少 poppler 工具：" + poppler.missing.join("、"));
    return 2;
  }

  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write("无法读取目录 " + outputDir + "：" + (err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }
  const docxFiles = entries
    .filter((entry) => entry.isFile() && /\.docx$/i.test(entry.name))
    .map((entry) => path.join(outputDir, entry.name))
    .sort();
  if (docxFiles.length === 0) {
    process.stderr.write("目录 " + outputDir + " 下未找到 .docx 文件。\n");
    process.stderr.write("可用 --dir <目录> 指定其它目录。\n");
    return 1;
  }

  let visionPort: VisionReviewPort | undefined;
  if (vision) {
    const model = config.officeRender.visionModel.trim() || config.ocr.model.trim();
    if (model === "") {
      process.stderr.write("[WARN] 未配置视觉模型（OFFICERENDER__VISION_MODEL / OCR__MODEL），视觉复核将跳过。\n");
    } else {
      visionPort = new GatewayVisionReview({ model, timeoutMs: config.ocr.timeoutMs });
    }
  }

  const qa = new OfficeQaService({
    renderer,
    runner,
    ...(visionPort ? { vision: visionPort } : {}),
    binaries: poppler.binaries,
    limits: {
      maxPages: config.officeRender.maxPages,
      maxVisionImages: config.officeRender.maxImages,
      dpi: config.officeRender.dpi,
      convertTimeoutMs: config.officeRender.timeoutMs,
      commandTimeoutMs: 30_000,
    },
  });

  const reportsDir = path.join(outputDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const records: QaRecord[] = [];
  for (const [index, file] of docxFiles.entries()) {
    const fileName = path.basename(file);
    process.stdout.write("[" + (index + 1) + "/" + docxFiles.length + "] " + fileName + " ... ");
    let audit: DocxAudit;
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      audit = await qa.audit(
        { fileName, bytes },
        {
          ...(maxPages > 0 || vision ? { renderPages: true } : {}),
          ...(vision ? { vision: true } : {}),
          ...(maxPages > 0 ? { maxPages } : {}),
        },
      );
    } catch (err) {
      audit = {
        available: false,
        reason: "质检过程异常：" + (err instanceof Error ? err.message : String(err)),
        pageCount: 0,
        pageSize: { widthPt: 0, heightPt: 0 },
        findings: [],
        checks: [],
        score: 0,
      };
    }
    const report = safeReportName(fileName);
    await fs.writeFile(path.join(reportsDir, report), renderAuditMarkdown(audit), "utf8");
    records.push({ fileName, report, audit });
    process.stdout.write(
      audit.available
        ? "score=" + audit.score + "（错误 " + countSeverity(audit, "error") + " / 警告 " + countSeverity(audit, "warning") + "）\n"
        : "不可用：" + (audit.reason ?? "未知原因") + "\n",
    );
    log.info("[OFFICE-QA-CLI] audited file=%s available=%s score=%d", fileName, audit.available, audit.score);
  }

  const summary = buildSummary(records, outputDir, maxPages, vision);
  await fs.writeFile(path.join(outputDir, "report.md"), summary, "utf8");
  await fs.writeFile(
    path.join(outputDir, "report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        directory: outputDir,
        renderPages: maxPages,
        vision,
        documents: records.map((record) => ({
          fileName: record.fileName,
          report: record.report,
          available: record.audit.available,
          ...(record.audit.available
            ? {
                score: record.audit.score,
                pageCount: record.audit.pageCount,
                pageSize: record.audit.pageSize,
                findings: record.audit.findings,
                checks: record.audit.checks,
              }
            : { reason: record.audit.reason, findings: [], checks: record.audit.checks }),
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const unavailableCount = records.filter((record) => !record.audit.available).length;
  process.stdout.write("\n汇总报告：" + path.join(outputDir, "report.md") + "\n");
  process.stdout.write("结构化结果：" + path.join(outputDir, "report.json") + "\n");
  if (unavailableCount === records.length) return 2;
  return unavailableCount > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write("质检脚本异常：" + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 2;
  });
