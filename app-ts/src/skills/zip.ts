import JSZip from "jszip";

/**
 * Skill zip parsing — port of the Python zip_parser. Layout:
 *   manifest.json  {name, description, version, has_code_tools, entry, ...}
 *   SKILL.md       instruction body (leading YAML front matter stripped)
 *   tools/         each text file is a runnable code tool (entry default main.py)
 * Entries are located nearest-root (GitHub zipball `owner-repo-sha/` prefixes supported).
 */

export interface SkillManifest {
  skill_id?: string;
  name?: string;
  description?: string;
  version?: string;
  has_code_tools?: boolean;
  entry?: string;
  [key: string]: unknown;
}

export interface ParsedSkill {
  manifest: SkillManifest;
  body: string;
  files: Array<{ name: string; path: string; size: number }>;
  /** 文本文件内容表（渐进式加载：load_skill(name, path) 按需读取 references 等） */
  fileMap: Record<string, string>;
  codeTools: Record<string, string>;
  entry: string;
}

/** Strip leading YAML front matter (--- ... ---) from SKILL.md. */
export function stripFrontMatter(text: string): string {
  return parseFrontMatter(text).body;
}

/**
 * Minimal YAML front-matter parser for SKILL.md — top-level `key: value` pairs
 * (quoted strings / numbers / booleans; nested structures ignored). This is the
 * Claude Code / Codex skill convention: name + description live in front
 * matter, the body is the instruction, extra files are loaded on demand.
 */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: normalized };
  const header = normalized.slice(normalized.indexOf("\n", 3) + 1, end);
  const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1);
  const data: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let value: unknown = m[2].trim();
    if (typeof value === "string") {
      const q = value.match(/^"([\s\S]*)"$/) || value.match(/^'([\s\S]*)'$/);
      if (q) value = q[1];
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    }
    data[m[1]] = value;
  }
  return { data, body };
}

function findNearestRoot(zip: JSZip, suffix: string): string | undefined {
  let best: string | undefined;
  for (const path of Object.keys(zip.files)) {
    if (!path.endsWith(suffix)) continue;
    if (best === undefined || path.length < best.length) best = path;
  }
  return best;
}

export async function parseSkillZip(data: Buffer | Uint8Array): Promise<ParsedSkill> {
  const zip = await JSZip.loadAsync(data).catch(() => {
    throw new Error("无法解析 zip 文件");
  });

  const manifestPath = findNearestRoot(zip, "manifest.json");
  let manifest: SkillManifest = {};
  if (manifestPath) {
    const raw = await zip.file(manifestPath)!.async("string");
    try {
      manifest = JSON.parse(raw) as SkillManifest;
    } catch {
      throw new Error("manifest.json 不是合法 JSON");
    }
  }

  // SKILL.md（Claude Code / Codex 约定）：front matter 解析为元数据补位
  // （manifest.json 字段优先），正文为指令体。
  const skillMdPath = findNearestRoot(zip, "SKILL.md");
  let body = "";
  if (skillMdPath) {
    const parsedMd = parseFrontMatter(await zip.file(skillMdPath)!.async("string"));
    body = parsedMd.body;
    manifest = { ...parsedMd.data, ...manifest };
  }

  const codeTools: Record<string, string> = {};
  const fileMap: Record<string, string> = {};
  const files: Array<{ name: string; path: string; size: number }> = [];
  let hasTools = false;
  const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|py|sh|js|ts|csv|html?|toml)$/i;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const rel = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const size = (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    files.push({ name: rel, path, size });
    const toolsIndex = path.indexOf("tools/");
    if (toolsIndex !== -1) {
      hasTools = true;
      const toolRel = path.slice(toolsIndex + "tools/".length);
      codeTools[toolRel] = await entry.async("string");
      continue;
    }
    // 渐进式披露：文本文件存入 fileMap，load_skill(name, path) 按需读取
    if (TEXT_EXT.test(path) && size <= 256_000) {
      fileMap[path] = await entry.async("string");
    }
  }

  const entry = (manifest.entry as string) || findNearestRoot(zip, "main.py")?.split("/").pop() || "main.py";
  if (hasTools) manifest.has_code_tools = true;

  return { manifest, body, files, fileMap, codeTools, entry };
}
