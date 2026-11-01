#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — 跨平台 FFmpeg sidecar 准备脚本（Windows / macOS / Linux）。
 *
 * Tauri 的 bundle.externalBin 要求 sidecar 文件按
 *   binaries/<name>-<target-triple>[.exe]
 * 命名。Windows 用 fetch-ffmpeg.ps1 下载/复制；这个脚本给 macOS / Linux
 * （以及不想用 PowerShell 的 Windows 用户）提供同样能力：
 *
 *   node scripts/fetch-ffmpeg.mjs            # 从 PATH / 常见安装位置复制
 *   node scripts/fetch-ffmpeg.mjs --source /opt/ffmpeg/bin
 *   node scripts/fetch-ffmpeg.mjs --force    # 覆盖已有 sidecar
 *
 * 脚本只复制本机已安装的 ffmpeg/ffprobe，不联网下载（避免供应链与
 * GPL 分发问题）；没有找到时给出安装指引并以非 0 退出。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const binariesDir = join(desktopRoot, "src-tauri", "binaries");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
}
const sourceDir = argValue("--source");
const force = process.argv.includes("--force");

function rustHostTriple() {
  const probe = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (probe.status === 0) {
    const line = probe.stdout.split(/\r?\n/).find((item) => item.startsWith("host: "));
    if (line) return line.slice("host: ".length).trim();
  }
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  return "";
}

function candidates(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const list = [];
  if (sourceDir) list.push(join(sourceDir, exe));
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) if (dir.trim() !== "") list.push(join(dir, exe));
  if (process.platform === "win32") {
    list.push(`C:\\ffmpeg\\bin\\${exe}`, `C:\\Program Files\\ffmpeg\\bin\\${exe}`);
  } else {
    list.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/opt/local/bin/${name}`);
  }
  return list;
}

function findBinary(name) {
  for (const candidate of candidates(name)) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function main() {
  const triple = rustHostTriple();
  if (!triple) {
    console.error("[fetch-ffmpeg] 无法确定 Rust target triple（请先安装 rustup/cargo）");
    process.exit(1);
  }
  mkdirSync(binariesDir, { recursive: true });
  const suffix = process.platform === "win32" ? ".exe" : "";
  let missing = 0;
  for (const name of ["ffmpeg", "ffprobe"]) {
    const source = findBinary(name);
    const target = join(binariesDir, `${name}-${triple}${suffix}`);
    if (source === null) {
      console.error(
        `[fetch-ffmpeg] 找不到 ${name}。请先安装 FFmpeg（Linux: apt install ffmpeg / dnf install ffmpeg；` +
        "macOS: brew install ffmpeg；Windows: https://ffmpeg.org/download.html），" +
        "或用 --source 指向 ffmpeg/ffprobe 所在目录。",
      );
      missing += 1;
      continue;
    }
    if (existsSync(target) && !force) {
      console.log(`[fetch-ffmpeg] 已存在，跳过：${target}（--force 覆盖）`);
      continue;
    }
    copyFileSync(source, target);
    console.log(`[fetch-ffmpeg] ${source} -> ${target}`);
  }
  if (missing > 0) process.exit(1);
  console.log(`[fetch-ffmpeg] 完成：${triple} sidecar 已就绪`);
}

main();
