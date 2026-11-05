import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { InternalServiceClient } from "../transport/internal-client.js";

const log = createLogger("APP_BILI");

/**
 * Client for the acquisition service's internal M2M face (/internal/bili/*):
 * read-only knowledge scope (folder → video → page tree with ASR state) and
 * the bvid ownership check for knowledge deletion. Guard = shared apikey,
 * mirroring the app-pay / app-quiz internal clients. Scope responses are
 * cached briefly per uid (the tree is scanned by several endpoints).
 * Fail-open by design: scope() returns [] when app-bili is unreachable.
 */

export interface ScopePage {
  cid: number;
  page_index: number;
  page_title: string;
  is_processed: boolean;
  version: number;
}

export interface ScopeVideo {
  bvid: string;
  title: string;
  pages: ScopePage[];
}

export interface ScopeFolder {
  media_id: number;
  media_count: number | null;
  last_sync_at: string;
  videos: ScopeVideo[];
}

export class AppBiliClient extends InternalServiceClient {
  private readonly cacheTtlMs: number;
  private readonly scopeCache = new Map<string, { at: number; folders: ScopeFolder[] }>();

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number; cacheTtlMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appBili.baseUrl,
        apiKey: opts?.apiKey ?? config.appBili.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appBili.timeoutMs,
      },
      "app-bili",
    );
    this.cacheTtlMs = opts?.cacheTtlMs ?? config.appBili.cacheTtlMs;
  }

  /** Folder→video→page tree for a user. Empty array on upstream failure (fail-open). */
  async scope(uid: string): Promise<ScopeFolder[]> {
    const cached = this.scopeCache.get(uid);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.folders;
    }
    try {
      const res = await this.request("GET", `/internal/bili/scope?uid=${uid}`);
      const body = await this.json<{ folders?: ScopeFolder[] }>(res, "app-bili scope");
      const folders = body.folders ?? [];
      this.scopeCache.set(uid, { at: Date.now(), folders });
      return folders;
    } catch (err) {
      log.warn(`[SCOPE] failed uid=${uid}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async owns(uid: string, bvid: string): Promise<boolean> {
    const folders = await this.scope(uid);
    return folders.some((f) => f.videos.some((v) => v.bvid === bvid));
  }

  /** Evict one user's cached scope (call after ownership-relevant writes). */
  invalidateScope(uid: string): void {
    this.scopeCache.delete(uid);
  }
}
