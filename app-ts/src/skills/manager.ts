import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { parseSkillZip, type ParsedSkill } from "./zip.js";

const log = createLogger("SKILLS");

/**
 * Skill manager — per-user installed skills (MinIO zip store + Mongo metadata,
 * a storage redesign vs the Python MySQL rows; wire contract unchanged) plus
 * the GitHub-based skill store browser. The agent sees installed skills via
 * indexSection() in its system prompt and loads bodies with load_skill.
 */

export interface InstalledSkill {
  skillId: string;
  name: string;
  description: string | null;
  version: string | null;
  sourceStore: string | null;
  hasCodeTools: boolean;
  enabled: boolean;
}

export interface SkillRecord extends InstalledSkill {
  minioKey: string;
}

export class SkillError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Zip object storage — S3-compatible via the minio SDK (nil = disabled). */
export interface SkillZipStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export interface SkillMetaRepository {
  list(uid: string): Promise<SkillRecord[]>;
  get(uid: string, skillId: string): Promise<SkillRecord | undefined>;
  save(uid: string, record: SkillRecord): Promise<void>;
  remove(uid: string, skillId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class SkillManager {
  private readonly store: SkillZipStore | null;
  private readonly meta: SkillMetaRepository;
  private readonly bodyCache = new Map<string, ParsedSkill>(); // key `${uid}:${skillId}`

  constructor(deps: { zipStore?: SkillZipStore | null; meta: SkillMetaRepository }) {
    this.store = deps.zipStore ?? null;
    this.meta = deps.meta;
  }

  /** Build the per-user skill index for the agent system prompt (empty when none). */
  async indexSection(uid: string): Promise<string> {
    const skills = await this.meta.list(uid);
    const enabled = skills.filter((s) => s.enabled);
    if (enabled.length === 0) return "";
    const lines = enabled.map((s) => `- ${s.skillId}: ${s.description || s.name}`);
    return ["## 可用技能（Skills）", "当用户任务匹配某技能时，调用 load_skill(name) 加载详细指令：", ...lines].join("\n");
  }

  /** Forced-skill injection: full SKILL.md bodies for the selected ids. */
  async forcedSection(uid: string, skillIds: string[]): Promise<string> {
    if (skillIds.length === 0) return "";
    const sections: string[] = [];
    for (const skillId of skillIds) {
      const record = await this.meta.get(uid, skillId);
      if (!record) continue;
      try {
        const parsed = await this.loadParsed(uid, skillId, record.minioKey);
        sections.push(`### 技能：${record.name}（${skillId}）\n\n${parsed.body}`);
      } catch (err) {
        log.warn(`forced skill load failed uid=${uid} skill=${skillId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (sections.length === 0) return "";
    return ["## 用户指定技能（本次对话必须遵循）", ...sections].join("\n\n");
  }

  async listInstalled(uid: string): Promise<InstalledSkill[]> {
    const rows = await this.meta.list(uid);
    return rows.filter((r) => r.enabled).map(({ minioKey: _k, ...rest }) => rest);
  }

  async install(uid: string, input: {
    skillId: string;
    name: string;
    description: string | null;
    version: string | null;
    sourceStore: string;
    zip: Buffer;
  }): Promise<InstalledSkill> {
    if (!this.store) throw new SkillError(503, "对象存储不可用");
    const parsed = await parseSkillZip(input.zip).catch((err: Error) => {
      throw new SkillError(400, `安装失败: ${err.message}`);
    });
    const skillId = parsed.manifest.skill_id || input.skillId;
    if (!skillId) throw new SkillError(400, "无法确定 skill_id（manifest 缺失且无文件名）");
    const key = `skills/${uid}/${skillId}.zip`;
    await this.store.put(key, input.zip, "application/zip");
    const record: SkillRecord = {
      skillId,
      name: parsed.manifest.name || input.name || skillId,
      description: parsed.manifest.description ?? input.description,
      version: parsed.manifest.version ?? input.version,
      sourceStore: input.sourceStore,
      hasCodeTools: Boolean(parsed.manifest.has_code_tools),
      enabled: true,
      minioKey: key,
    };
    await this.meta.save(uid, record);
    this.bodyCache.delete(`${uid}:${skillId}`);
    const { minioKey: _k, ...rest } = record;
    return rest;
  }

  async uninstall(uid: string, skillId: string): Promise<string> {
    const record = await this.meta.get(uid, skillId);
    if (!record) throw new SkillError(404, `未安装的技能: ${skillId}`);
    if (this.store) {
      await this.store.remove(record.minioKey).catch((err: Error) => {
        log.warn(`zip removal failed skill=${skillId}: ${err.message}`);
      });
    }
    await this.meta.remove(uid, skillId);
    this.bodyCache.delete(`${uid}:${skillId}`);
    return skillId;
  }

  async preview(uid: string, skillId: string): Promise<Record<string, unknown>> {
    const record = await this.meta.get(uid, skillId);
    if (!record) throw new SkillError(404, "未安装或不可访问: " + skillId);
    const parsed = await this.loadParsed(uid, skillId, record.minioKey);
    return {
      skill_id: record.skillId,
      name: record.name,
      description: record.description,
      version: record.version,
      has_code_tools: record.hasCodeTools,
      body: parsed.body,
      manifest: parsed.manifest,
      files: parsed.files,
      code_tools: Object.keys(parsed.codeTools),
      entry: parsed.entry,
    };
  }

  /** load_skill tool body — "# 技能: {name}\n\n{body}" + code-tool pointers. */
  async loadBody(uid: string, skillId: string): Promise<string> {
    const record = await this.meta.get(uid, skillId);
    if (!record) {
      const all = await this.meta.list(uid);
      const ids = all.filter((s) => s.enabled).map((s) => s.skillId).join(", ");
      return `未知技能 '${skillId}'。可用技能: ${ids || "无"}`;
    }
    const parsed = await this.loadParsed(uid, skillId, record.minioKey);
    let out = `# 技能: ${record.name}\n\n${parsed.body}`;
    if (record.hasCodeTools) {
      const tools = Object.keys(parsed.codeTools).join(", ") || "无";
      out += `\n\n## 代码工具\n可用脚本: ${tools}（入口 ${parsed.entry}）。沙箱不可用时请说明代码工具暂不可用。`;
    }
    return out;
  }

  private async loadParsed(uid: string, skillId: string, minioKey: string): Promise<ParsedSkill> {
    const cacheKey = `${uid}:${skillId}`;
    const cached = this.bodyCache.get(cacheKey);
    if (cached) return cached;
    if (!this.store) throw new SkillError(503, "对象存储不可用");
    const zip = await this.store.get(minioKey);
    const parsed = await parseSkillZip(zip);
    if (this.bodyCache.size >= 32) {
      const first = this.bodyCache.keys().next().value;
      if (first) this.bodyCache.delete(first);
    }
    this.bodyCache.set(cacheKey, parsed);
    return parsed;
  }
}

// ── GitHub skill store ────────────────────────────────────────────────

export interface StoreRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  default_branch: string;
  html_url: string;
}

export class SkillStoreClient {
  private readonly api: string;
  private readonly topic: string;
  private readonly apiKey: string;
  private readonly searchCache = new Map<string, { at: number; repos: StoreRepo[] }>();

  constructor(opts?: { api?: string; topic?: string; apiKey?: string }) {
    this.api = (opts?.api ?? config.skills.storeApiUrl).replace(/\/$/, "");
    this.topic = opts?.topic ?? config.skills.storeTopic;
    this.apiKey = opts?.apiKey ?? config.skills.storeApiKey;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": "mindbase-app-ts",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async search(query?: string): Promise<StoreRepo[]> {
    const q = query?.trim() || `topic:${this.topic}`;
    const cached = this.searchCache.get(q);
    if (cached && Date.now() - cached.at < 300_000) return cached.repos;
    const res = await fetch(`${this.api}/search/repositories?q=${encodeURIComponent(q)}&per_page=30`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new SkillError(502, "store 访问失败: GitHub HTTP " + res.status);
    const body = (await res.json()) as { items?: StoreRepo[] };
    const repos = (body.items ?? []).map((r) => ({
      full_name: r.full_name,
      description: r.description,
      stargazers_count: r.stargazers_count,
      default_branch: r.default_branch,
      html_url: r.html_url,
    }));
    this.searchCache.set(q, { at: Date.now(), repos });
    return repos;
  }

  async contents(repo: string, branch: string, path: string): Promise<unknown> {
    const res = await fetch(
      `${this.api}/repos/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new SkillError(502, "store 访问失败: GitHub HTTP " + res.status);
    const body = (await res.json()) as
      | Array<{ type: string; name: string; path: string; size: number }>
      | { type: string; name: string; path: string; size: number; content?: string };
    if (Array.isArray(body)) {
      return {
        type: "dir",
        entries: body.map((e) => ({ name: e.name, type: e.type, path: e.path, size: e.size })),
      };
    }
    const content = body.content ? Buffer.from(body.content, "base64").toString("utf-8") : "";
    return { type: "file", name: body.name, path: body.path, content };
  }

  async downloadZipball(repo: string, branch: string): Promise<Buffer> {
    const res = await fetch(`${this.api}/repos/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(branch)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new SkillError(502, "下载失败: GitHub HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
