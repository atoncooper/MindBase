import { promises as fs } from "node:fs";
import path from "node:path";

import { validateDocumentIR } from "../src/services/office/ir.js";
import { auditDocumentStructure, renderStructuralAudit } from "../src/services/office/qa-structural.js";
import { getDocTemplate, resolveTemplate } from "../src/services/office/templates.js";

/**
 * Render-free document audit (no LibreOffice required).
 *
 * Usage: npm run audit:office -- [--dir qa-output] [--json]
 * Reads every *.ir.json (Document IR dumped by scripts/office-samples.ts), runs
 * the structural + content-quality audit against the selected template, prints a
 * Chinese report and exits 1 when any document has error-level findings.
 * Pixel-level checks live in scripts/office-qa.ts (needs LibreOffice + poppler).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  const dir = dirIndex >= 0 && args[dirIndex + 1] ? args[dirIndex + 1] : "qa-output";
  const asJson = args.includes("--json");

  const entries = await fs.readdir(dir);
  const irFiles = entries.filter((name) => name.endsWith(".ir.json"));
  if (irFiles.length === 0) {
    console.error("没有找到 *.ir.json（先运行 npm run samples:office）");
    process.exit(2);
  }

  let hasError = false;
  const results: Array<{ name: string; score: number; estimatedPages: number; errors: number; warnings: number }> = [];
  for (const file of irFiles.sort()) {
    const raw = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as Record<string, unknown>;
    const ir = validateDocumentIR(raw);
    const template = getDocTemplate(
      typeof raw.template === "string" ? raw.template : resolveTemplate({ titleHint: ir.title }).template.id,
    );
    const audit = auditDocumentStructure(ir, template);
    const errors = audit.findings.filter((finding) => finding.severity === "error");
    const warnings = audit.findings.filter((finding) => finding.severity === "warning");
    if (errors.length > 0) hasError = true;
    results.push({ name: file, score: audit.score, estimatedPages: audit.estimatedPages, errors: errors.length, warnings: warnings.length });
    if (!asJson) {
      console.log("\n=== " + file + "（模板 " + template.id + "）===");
      console.log(renderStructuralAudit(audit));
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: !hasError, dir, results }, null, 2));
  } else {
    console.log("\n汇总：" + results.map((entry) => entry.name.replace(".ir.json", "") + " " + entry.score + "分/" + entry.estimatedPages + "页").join("；"));
  }
  process.exit(hasError ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
