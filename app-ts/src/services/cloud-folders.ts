import { createLogger } from "../logger.js";

const log = createLogger("CLOUD-FOLDERS");

/**
 * Cloud-drive folder resolution for agent-generated files.
 *
 * Product rule: everything the agent produces lands in the user's "agent/"
 * folder (created at registration). That folder may be missing for older users
 * or after a failed registration hook, so this service owns the find-or-create
 * path and caches the result — without the cache every export would list the
 * drive twice (root, then the sub-folder).
 *
 * Scope is deliberately narrow: only the agent tree is resolved here. Research
 * workspaces keep their own folder mapping (ResearchWorkspaceService); sharing
 * one cache between both would make either side's invalidation unreliable.
 */

export interface CloudFolderNode {
  id: number;
  name: string;
  parent_id?: number;
}

/** Transport surface needed from app-cloud (tests inject a fake). */
export interface CloudFolderPort {
  readonly configured: boolean;
  listFolders(uid: string, parentId?: number): Promise<CloudFolderNode[]>;
  createFolder(uid: string, name: string, parentId?: number): Promise<CloudFolderNode>;
}

export type CloudFolderErrorCode = "invalid" | "cloud_unavailable";

export class CloudFolderError extends Error {
  readonly code: CloudFolderErrorCode;

  constructor(
    code: CloudFolderErrorCode,
    message: string,
    /** HTTP status when the failure came from the cloud API (404 = old app-cloud). */
    readonly status?: number,
  ) {
    super(message);
    this.name = "CloudFolderError";
    this.code = code;
  }
}

export interface CloudFolderServiceOptions {
  cloud: CloudFolderPort;
  /** Root folder under the drive root, e.g. "agent". */
  rootFolder: string;
  /** Cached folder ids stay valid this long (ms). */
  cacheTtlMs?: number;
  now?: () => number;
}

/** One path segment: control characters are dropped, "."/".." is rejected. */
function normalizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" ) throw new CloudFolderError("invalid", "文件夹名不能为空");
  if (cleaned === "." || cleaned === "..") throw new CloudFolderError("invalid", "文件夹名不能是 . 或 ..");
  if (cleaned.length > 60) throw new CloudFolderError("invalid", "文件夹名过长（单段最多 60 字符）");
  return cleaned;
}

/** "a/b/c" -> ["a","b","c"]; empty path -> [] (the root folder itself). */
export function parseFolderPath(relativePath: string | undefined, maxDepth = 6): string[] {
  const raw = (relativePath ?? "").trim();
  if (raw === "") return [];
  const segments = raw
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (segments.length > maxDepth) {
    throw new CloudFolderError("invalid", "文件夹层级过深（最多 " + maxDepth + " 层）");
  }
  return segments.map(normalizeSegment);
}

/** HTTP status carried by an error from the cloud transport (duck-typed). */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

/** A missing M2M route: 404 or gin's plain-text "404 page not found" body. */
function isMissingEndpoint(err: unknown): boolean {
  if (statusOf(err) === 404) return true;
  const text = err instanceof Error ? err.message : String(err);
  return /page not found|HTTP 404|^404\b/i.test(text);
}

export class CloudFolderService {
  private readonly cache = new Map<string, { id: number; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<number>>();

  constructor(private readonly options: CloudFolderServiceOptions) {}

  /**
   * Ensures <rootFolder>/<relativePath> exists and returns the leaf folder id.
   * Creates missing levels one by one; concurrent calls for the same path share
   * one resolution so two parallel exports cannot create duplicates.
   */
  async ensurePath(uid: string, relativePath?: string): Promise<{ folderId: number; path: string }> {
    const segments = [this.options.rootFolder, ...parseFolderPath(relativePath)];
    const key = this.cacheKey(uid, segments);
    const path = segments.join("/");

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return { folderId: cached.id, path };

    const running = this.inflight.get(key);
    if (running) return { folderId: await running, path };

    const task = this.resolvePath(uid, segments).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    const folderId = await task;
    this.cache.set(key, { id: folderId, expiresAt: this.now() + this.ttl() });
    return { folderId, path };
  }

  /** Drops every cached id for one user (after a manual folder move/delete). */
  invalidate(uid: string): void {
    const prefix = uid + ":";
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  private async resolvePath(uid: string, segments: string[]): Promise<number> {
    if (!this.options.cloud.configured) {
      throw new CloudFolderError("cloud_unavailable", "云盘服务未配置，无法定位保存目录");
    }
    let parentId: number | undefined;
    let parentLabel = "";
    for (const segment of segments) {
      const children = await this.list(uid, parentId);
      const existing = children.find((node) => node.name.toLowerCase() === segment.toLowerCase());
      if (existing) {
        parentId = existing.id;
      } else {
        try {
          const created = await this.options.cloud.createFolder(uid, segment, parentId);
          log.info("[CLOUD-FOLDERS] created folder uid=%s path=%s id=%s", uid, segment, created.id);
          parentId = created.id;
        } catch (err) {
          // A parallel writer (registration hook, another tab) may have won the
          // race: re-list once and reuse its folder instead of surfacing an error.
          const retry = await this.list(uid, parentId);
          const winner = retry.find((node) => node.name.toLowerCase() === segment.toLowerCase());
          if (!winner) {
            throw new CloudFolderError(
              "cloud_unavailable",
              "创建云盘文件夹失败（" + (parentLabel || "根目录") + "/" + segment + "）：" +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          parentId = winner.id;
        }
      }
      parentLabel = parentLabel === "" ? segment : parentLabel + "/" + segment;
    }
    if (parentId === undefined) {
      throw new CloudFolderError("cloud_unavailable", "无法定位云盘保存目录");
    }
    return parentId;
  }

  private async list(uid: string, parentId?: number): Promise<CloudFolderNode[]> {
    try {
      return await this.options.cloud.listFolders(uid, parentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A 404 here means the running app-cloud predates the M2M folder listing
      // route (gin's bare "404 page not found"). Flag it so callers can degrade
      // to the drive root instead of failing the whole export, and so operators
      // see the real fix (rebuild + restart app-cloud).
      if (isMissingEndpoint(err)) {
        throw new CloudFolderError(
          "cloud_unavailable",
          "云盘目录接口不可用（app-cloud 缺少 GET /internal/cloud/folders，需重新构建并重启 app-cloud）：" + message,
          404,
        );
      }
      throw new CloudFolderError("cloud_unavailable", "读取云盘目录失败：" + message, statusOf(err));
    }
  }

  private cacheKey(uid: string, segments: string[]): string {
    return uid + ":" + segments.join("/").toLowerCase();
  }

  private ttl(): number {
    const ttl = this.options.cacheTtlMs ?? 600_000;
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
