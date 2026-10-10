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
  codeTools: Record<string, string>;
  entry: string;
}

/** Strip leading YAML front matter (--- ... ---) from SKILL.md. */
export function stripFrontMatter(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return normalized;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized;
  return normalized.slice(normalized.indexOf("\n", end + 1) + 1);
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

  const skillMdPath = findNearestRoot(zip, "SKILL.md");
  const body = skillMdPath ? stripFrontMatter(await zip.file(skillMdPath)!.async("string")) : "";

  const codeTools: Record<string, string> = {};
  const files: Array<{ name: string; path: string; size: number }> = [];
  let hasTools = false;
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
    }
  }

  const entry = (manifest.entry as string) || findNearestRoot(zip, "main.py")?.split("/").pop() || "main.py";
  if (hasTools) manifest.has_code_tools = true;

  return { manifest, body, files, codeTools, entry };
}
