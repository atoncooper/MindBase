/**
 * DOCX visual regression CLI (offline-testable).
 *
 * Every .docx in a folder -> LibreOffice (or the configured converter) -> PDF ->
 * pdftotext -bbox-layout -> normalized text/coordinate/size snapshot, compared
 * with the golden JSON in test/golden/office/<name>.json.
 *
 * Usage:
 *   npm run eval:office -- [--dir <folder>] [--golden <dir>] [--file <name>] [--update]
 *
 *   --dir     folder containing .docx files (default: app-ts/qa-output)
 *   --golden  golden directory (default: app-ts/test/golden/office)
 *   --file    only check the named .docx (repeatable)
 *   --pdf-dir use already-converted <stem>.pdf files instead of LibreOffice
 *             (offline golden generation; still needs poppler pdftotext)
 *   --update  write/refresh the goldens instead of comparing
 *
 * Exit codes:
 *   0 = every document matches its golden (or --update rewrote them)
 *   1 = at least one document differs / is missing its golden / no .docx found
 *   2 = the environment cannot render (no LibreOffice, no pdftotext, ...);
 *       the check did not run — never reported as success
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CommandRunner } from "../src/services/office-render/process.js";
import { NodeCommandRunner } from "../src/services/office-render/process.js";
import type { OfficeRenderPort } from "../src/services/office-render/renderer.js";
import { createOfficeRenderer, resolveBinary } from "../src/services/office-render/renderer.js";
import { VISUAL_EXIT, runVisualRegression, type VisualExitCode } from "../src/services/office/qa-visual.js";

export interface VisualCliDeps {
  /** Injected renderer (tests); production resolves one from config. */
  renderer?: OfficeRenderPort;
  /** Injected command runner (tests); production spawns real binaries. */
  runner?: CommandRunner;
  /** Resolved pdftotext path; production resolves it from PATH. */
  pdftotextPath?: string;
  timeoutMs?: number;
  /** Base directory for relative --dir/--golden paths (default: process.cwd()). */
  cwd?: string;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

interface CliArgs {
  dir: string;
  golden: string;
  files: string[];
  update: boolean;
  pdfDir?: string;
}

function argValue(argv: string[], flag: string): string | undefined {
  const eqPrefix = flag + "=";
  const eqArg = argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqArg) return eqArg.slice(eqPrefix.length);
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

function argValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === flag) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) values.push(next);
    } else if (arg.startsWith(flag + "=")) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    dir: argValue(argv, "--dir") ?? "qa-output",
    golden: argValue(argv, "--golden") ?? "test/golden/office",
    files: argValues(argv, "--file"),
    update: argv.includes("--update"),
    ...(argValue(argv, "--pdf-dir") ? { pdfDir: argValue(argv, "--pdf-dir") } : {}),
  };
}

function printUnavailable(writeError: (line: string) => void, reason: string): void {
  writeError("");
  writeError("无法进行视觉回归：" + reason);
  writeError("需要 LibreOffice（soffice）或已配置的远程转换服务，以及 poppler-utils（pdftotext）。");
  writeError("请安装后重试；本脚本在缺少依赖时不会输出任何伪造的通过结果。");
}

/**
 * Runs the CLI and returns its exit code (0/1/2). All environment-dependent
 * collaborators are injectable so the unit test never needs LibreOffice.
 */
export async function runVisualRegressionCli(argv: string[], deps: VisualCliDeps = {}): Promise<VisualExitCode> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line + "\n"));
  const baseDir = deps.cwd ?? process.cwd();
  const args = parseArgs(argv);
  const dir = path.resolve(baseDir, args.dir);
  const goldenDir = path.resolve(baseDir, args.golden);

  const runner = deps.runner ?? new NodeCommandRunner();
  const pdfDir = args.pdfDir ? path.resolve(baseDir, args.pdfDir) : undefined;
  let renderer = deps.renderer;
  if (!renderer && pdfDir === undefined) {
    const { config } = await import("../src/config/index.js");
    renderer = await createOfficeRenderer({
      runner,
      enabled: config.officeRender.enabled,
      sofficePath: config.officeRender.sofficePath,
      pdftoppmPath: config.officeRender.pdftoppmPath,
      timeoutMs: config.officeRender.timeoutMs,
      dpi: config.officeRender.dpi,
      maxPages: config.officeRender.maxPages,
      maxSourceBytes: config.officeExport.maxBytes,
    });
  }
  if (pdfDir === undefined) {
    if (renderer === undefined || !renderer.available || typeof renderer.convertToPdf !== "function") {
      printUnavailable(writeError, renderer?.unavailableReason ?? "当前渲染器不支持 DOCX→PDF 转换");
      return VISUAL_EXIT.unavailable;
    }
  }

  let pdftotextPath = deps.pdftotextPath;
  if (pdftotextPath === undefined) {
    const resolved = await resolveBinary("", "pdftotext");
    if (!resolved) {
      printUnavailable(writeError, "缺少 pdftotext（poppler-utils）");
      return VISUAL_EXIT.unavailable;
    }
    pdftotextPath = resolved;
  }

  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    writeError("无法读取目录 " + dir + "：" + (err instanceof Error ? err.message : String(err)));
    return VISUAL_EXIT.diff;
  }
  const wanted = new Set(args.files.map((name) => name.replace(/\.docx$/i, "").toLowerCase()));
  const docxFiles = entries
    .filter((entry) => entry.isFile() && /\.docx$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => wanted.size === 0 || wanted.has(name.replace(/\.docx$/i, "").toLowerCase()))
    .sort();
  if (docxFiles.length === 0) {
    writeError("目录 " + dir + " 下未找到匹配的 .docx 文件。可用 --dir <目录> 指定其它目录。");
    return VISUAL_EXIT.diff;
  }

  const cases = [];
  for (const fileName of docxFiles) {
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, fileName)));
    if (pdfDir !== undefined) {
      const stem = fileName.replace(/\.docx$/i, "");
      let pdf: Uint8Array;
      try {
        pdf = new Uint8Array(await fs.readFile(path.join(pdfDir, stem + ".pdf")));
      } catch {
        writeError("缺少预转换 PDF：" + path.join(pdfDir, stem + ".pdf") + "（--pdf-dir 模式下需要与 docx 同名的 PDF）");
        return VISUAL_EXIT.diff;
      }
      cases.push({ fileName, bytes, pdf });
      continue;
    }
    cases.push({ fileName, bytes });
  }

  const result = await runVisualRegression({
    cases,
    goldenDir,
    update: args.update,
    deps: {
      renderer:
        renderer ??
        ({
          available: false,
          unavailableReason: "--pdf-dir 模式不渲染 DOCX（只解析已有 PDF）",
          render: async () => {
            throw new Error("--pdf-dir 模式不渲染 DOCX");
          },
        } as OfficeRenderPort),
      runner,
      pdftotextPath,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    },
  });
  if (result.unavailableReason !== undefined) {
    printUnavailable(writeError, result.unavailableReason);
    return VISUAL_EXIT.unavailable;
  }

  write("视觉回归：" + dir + " -> " + goldenDir + (args.update ? "（写入 golden）" : ""));
  for (const item of result.results) {
    if (item.status === "pass") {
      write("  [PASS] " + item.name);
      continue;
    }
    if (item.status === "created") {
      write("  [GOLDEN] " + item.name + " -> " + item.goldenPath);
      continue;
    }
    write("  [" + (item.status === "missing" ? "MISSING" : "DIFF") + "] " + item.name);
    for (const issue of item.issues) write("      - " + issue);
  }
  const passed = result.results.filter((item) => item.status === "pass" || item.status === "created").length;
  write("汇总：" + passed + "/" + result.results.length + " 通过" + (args.update ? "（golden 已更新）" : ""));
  return result.exitCode;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /office-visual-regression\.[mc]?[tj]s$/.test(process.argv[1]);

if (invokedDirectly) {
  runVisualRegressionCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write("视觉回归脚本异常：" + (err instanceof Error ? err.message : String(err)) + "\n");
      process.exitCode = VISUAL_EXIT.unavailable;
    });
}
