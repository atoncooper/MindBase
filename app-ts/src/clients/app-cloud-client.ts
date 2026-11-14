import { config } from "../config/index.js";
import { InternalServiceClient } from "../transport/internal-client.js";

/**
 * Client for app-cloud's internal document-intelligence face
 * (GET /internal/cloud/summary?uid=&upload_uuid=, apikey-guarded).
 *
 * The cloud-drive file and its summary belong to app-cloud; app-ts only reads
 * them over this M2M face. Identity rides the X-Uid header and the uid query
 * parameter — both are filled from the authenticated tool context, never from
 * model-controlled arguments. Nothing is cached here: a re-ingest or a
 * regeneration must be observable on the next call.
 */

export interface CloudDocumentSummary {
  overview: string;
  topics: string[];
  entities: string[];
  key_points: string[];
  /** Executable follow-ups extracted from the document; empty for summaries generated before this field existed. */
  todos: string[];
  answers_questions: string[];
  language: string;
  size_chars: number;
}

export interface CloudSummaryResponse {
  upload_uuid: string;
  /** false = the document exists but no summary has been generated (yet). */
  available: boolean;
  /** true = the file content changed after the summary was generated. */
  stale: boolean;
  /** Model that produced the summary; empty when none. */
  model: string;
  summary: CloudDocumentSummary | null;
  /** File display name, supplied by the service when available. */
  title?: string;
  original_name?: string;
}

/** One ranked cloud-drive file returned by semantic search / similar files. */
export interface CloudSemanticHit {
  upload_uuid: string;
  /** File name as stored (always present on the wire). */
  original_name: string;
  /** Human title when the drive derived one; often empty. */
  title: string;
  mime_type: string;
  file_size: number;
  score: number;
  /** Distinct matching chunks, best first. */
  snippets: string[];
}

export interface CloudSemanticSearchResponse {
  mode: string;
  results: CloudSemanticHit[];
  total: number;
}

export interface CloudSimilarResponse {
  items: CloudSemanticHit[];
}

/** One cloud-drive document with parsed text — the KG build source (app-cloud M2M face). */
export interface CloudKgDocumentMeta {
  upload_uuid: string;
  title: string;
  /** app-cloud content hash; "" when the service did not report one */
  content_hash: string;
  /** parsed text length in characters (0 when unknown) */
  size_chars: number;
}

export interface CloudKgDocument extends CloudKgDocumentMeta {
  /** parsed plain text; app-cloud truncates very large documents server-side */
  text: string;
}

export interface CloudKgDocumentList {
  items: CloudKgDocumentMeta[];
  /** upload_uuid of the last row when the page is full; null = no more pages */
  next_cursor: string | null;
}

export class AppCloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AppCloudError";
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeHit(raw: unknown): CloudSemanticHit | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uploadUuid = optionalText(r.upload_uuid);
  if (uploadUuid === undefined) return null;
  return {
    upload_uuid: uploadUuid,
    original_name: optionalText(r.original_name) ?? "",
    title: optionalText(r.title) ?? "",
    mime_type: optionalText(r.mime_type) ?? "",
    file_size: finiteNumber(r.file_size, 0),
    score: finiteNumber(r.score, 0),
    snippets: stringList(r.snippets),
  };
}

function normalizeHits(raw: unknown): CloudSemanticHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: CloudSemanticHit[] = [];
  for (const item of raw) {
    const hit = normalizeHit(item);
    if (hit) hits.push(hit);
  }
  return hits;
}

function normalizeKgMeta(raw: unknown): CloudKgDocumentMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uploadUuid = optionalText(r.upload_uuid);
  if (uploadUuid === undefined) return null;
  return {
    upload_uuid: uploadUuid,
    title: optionalText(r.title) ?? "",
    content_hash: optionalText(r.content_hash) ?? "",
    size_chars: finiteNumber(r.size_chars, 0),
  };
}

function normalizeSummary(raw: unknown): CloudDocumentSummary | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const size = r.size_chars;
  return {
    overview: typeof r.overview === "string" ? r.overview : "",
    topics: stringList(r.topics),
    entities: stringList(r.entities),
    key_points: stringList(r.key_points),
    todos: stringList(r.todos),
    answers_questions: stringList(r.answers_questions),
    language: typeof r.language === "string" ? r.language : "",
    size_chars: typeof size === "number" && Number.isFinite(size) ? size : 0,
  };
}

export class AppCloudClient extends InternalServiceClient {
  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appCloud.baseUrl,
        apiKey: opts?.apiKey ?? config.appCloud.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appCloud.timeoutMs,
      },
      "app-cloud",
    );
  }

  /** Both halves are required: an apikey-less call would only ever collect 401/503. */
  get configured(): boolean {
    return this.baseUrl !== "" && this.apiKey !== "";
  }

  protected override error(message: string, status?: number): Error {
    return new AppCloudError(message, status);
  }

  /** Create a cloud-drive folder for a research workspace tree (M2M). */
  async createFolder(uid: string, name: string, parentId?: number): Promise<{ id: number; name: string; parent_id?: number }> {
    try {
      const res = await this.request(
        "POST",
        `/internal/cloud/folders?uid=${encodeURIComponent(uid)}`,
        { name, ...(parentId !== undefined ? { parentId } : {}) },
        uid,
      );
      const raw = await this.json<Record<string, unknown>>(res, "云盘文件夹创建失败");
      const id = Number(raw.ID ?? raw.id);
      if (!Number.isFinite(id) || id <= 0) throw new Error("云盘文件夹创建失败：响应缺少 id");
      return {
        id,
        name: typeof raw.Name === "string" ? raw.Name : name,
        ...(Number.isFinite(Number(raw.ParentID ?? raw.parentId))
          ? { parent_id: Number(raw.ParentID ?? raw.parentId) }
          : {}),
      };
    } catch (err) {
      if (err instanceof AppCloudError) throw err;
      throw new AppCloudError(`云盘文件夹创建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Upload raw bytes into a research workspace folder (M2M; app-cloud owns MinIO). */
  async uploadFile(
    uid: string,
    folderId: number,
    name: string,
    data: Uint8Array,
    mimeType = "application/octet-stream",
  ): Promise<{ upload_uuid: string; name: string; size: number; sha256?: string }> {
    const params = new URLSearchParams({
      uid,
      folder_id: String(folderId),
      name,
      mime_type: mimeType,
    });
    const res = await fetch(`${this.baseUrl}/internal/cloud/files?${params.toString()}`, {
      method: "POST",
      headers: this.headers(uid, { "Content-Type": mimeType }),
      body: data,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await this.json<Record<string, unknown>>(res, "云盘文件上传失败");
    const uploadUuid = typeof raw.upload_uuid === "string" ? raw.upload_uuid : "";
    if (!uploadUuid) throw new AppCloudError("云盘文件上传失败：响应缺少 upload_uuid");
    return {
      upload_uuid: uploadUuid,
      name: typeof raw.name === "string" ? raw.name : name,
      size: Number(raw.size ?? data.byteLength),
      ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
    };
  }

  /** Download a research workspace file (M2M). */
  async downloadFile(uid: string, uploadUuid: string): Promise<{ contentType: string; data: Uint8Array }> {
    const params = new URLSearchParams({ uid });
    const res = await fetch(
      `${this.baseUrl}/internal/cloud/files/${encodeURIComponent(uploadUuid)}?${params.toString()}`,
      { headers: this.headers(uid), signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new AppCloudError(`云盘文件下载失败：${text || res.status}`, res.status);
    }
    return {
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      data: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Delete one research workspace file (M2M soft delete). */
  async deleteFile(uid: string, uploadUuid: string): Promise<void> {
    const params = new URLSearchParams({ uid });
    const res = await this.request(
      "DELETE",
      `/internal/cloud/files/${encodeURIComponent(uploadUuid)}?${params.toString()}`,
      undefined,
      uid,
    );
    if (!res.ok) throw new AppCloudError(`云盘文件删除失败：HTTP ${res.status}`, res.status);
  }

  /** List files in one research workspace folder (M2M). */
  async listFiles(
    uid: string,
    folderId?: number,
  ): Promise<Array<{ upload_uuid: string; name: string; size: number; mime_type: string; folder_id?: number; sha256?: string; createdAt?: number }>> {
    const params = new URLSearchParams({ uid });
    if (folderId !== undefined) params.set("folder_id", String(folderId));
    const res = await this.request("GET", `/internal/cloud/files?${params.toString()}`, undefined, uid);
    const raw = await this.json<{ items?: unknown }>(res, "云盘文件列表读取失败");
    const items: Array<{ upload_uuid: string; name: string; size: number; mime_type: string; folder_id?: number; sha256?: string; createdAt?: number }> = [];
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.upload_uuid !== "string") continue;
      items.push({
        upload_uuid: r.upload_uuid,
        name: typeof r.name === "string" ? r.name : "",
        size: Number(r.size ?? 0),
        mime_type: typeof r.mime_type === "string" ? r.mime_type : "",
        ...(typeof r.folder_id === "number" ? { folder_id: r.folder_id } : {}),
        ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}),
        ...(typeof r.created_at === "number" ? { createdAt: r.created_at } : {}),
      });
    }
    return items;
  }

  /** Read one document's summary for `uid`; the uid is sent both as X-Uid and as the query identity. */
  async getSummary(uid: string, uploadUuid: string): Promise<CloudSummaryResponse> {
    const query = new URLSearchParams({ uid, upload_uuid: uploadUuid });
    try {
      const res = await this.request("GET", `/internal/cloud/summary?${query.toString()}`, undefined, uid);
      const raw = await this.json<Record<string, unknown>>(res, "云盘摘要读取失败");
      return this.normalize(raw, uploadUuid);
    } catch (err) {
      if (err instanceof AppCloudError) throw err;
      throw new AppCloudError(
        `云盘摘要服务调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Search the user's cloud drive by meaning; `folderId` scopes it to that folder's subtree. */
  async searchSemantic(
    uid: string,
    query: string,
    opts: { folderId?: number; limit?: number } = {},
  ): Promise<CloudSemanticSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (opts.folderId !== undefined) params.set("folderId", String(opts.folderId));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    try {
      const res = await this.request("GET", `/cloud/search/semantic?${params.toString()}`, undefined, uid);
      const raw = await this.json<Record<string, unknown>>(res, "云盘语义检索失败");
      const results = normalizeHits(raw.results);
      return {
        mode: optionalText(raw.mode) ?? "semantic",
        results,
        total: finiteNumber(raw.total, results.length),
      };
    } catch (err) {
      throw this.wrapCallFailure("云盘语义检索调用失败", err);
    }
  }

  /** Files whose content is closest to one owned file; the service excludes the file itself. */
  async getSimilar(uid: string, uploadUuid: string, limit?: number): Promise<CloudSimilarResponse> {
    const params = new URLSearchParams({ uid, upload_uuid: uploadUuid });
    if (limit !== undefined) params.set("limit", String(limit));
    try {
      const res = await this.request("GET", `/internal/cloud/similar?${params.toString()}`, undefined, uid);
      const raw = await this.json<Record<string, unknown>>(res, "云盘相似文件读取失败");
      return { items: normalizeHits(raw.items) };
    } catch (err) {
      throw this.wrapCallFailure("云盘相似文件调用失败", err);
    }
  }

  /**
   * List the user's cloud documents that have parsed text (KG build source),
   * one cursor page at a time (app-cloud: upload_uuid ASC pagination).
   */
  async listKgDocuments(
    uid: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CloudKgDocumentList> {
    const params = new URLSearchParams({ uid });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    try {
      const res = await this.request("GET", `/internal/cloud/kg/documents?${params.toString()}`, undefined, uid);
      const raw = await this.json<Record<string, unknown>>(res, "云盘文档列表读取失败");
      const items: CloudKgDocumentMeta[] = [];
      if (Array.isArray(raw.items)) {
        for (const item of raw.items) {
          const meta = normalizeKgMeta(item);
          if (meta) items.push(meta);
        }
      }
      return { items, next_cursor: optionalText(raw.next_cursor) ?? null };
    } catch (err) {
      throw this.wrapCallFailure("云盘文档列表调用失败", err);
    }
  }

  /** Read one document's parsed text for `uid`; undefined on 404 (missing / not parsed). */
  async getKgDocument(uid: string, uploadUuid: string): Promise<CloudKgDocument | undefined> {
    const params = new URLSearchParams({ uid, upload_uuid: uploadUuid });
    try {
      const res = await this.request("GET", `/internal/cloud/kg/document?${params.toString()}`, undefined, uid);
      const raw = await this.json<Record<string, unknown>>(res, "云盘文档正文读取失败");
      return {
        upload_uuid: optionalText(raw.upload_uuid) ?? uploadUuid,
        title: optionalText(raw.title) ?? "",
        content_hash: optionalText(raw.content_hash) ?? "",
        size_chars: finiteNumber(raw.size_chars, 0),
        text: typeof raw.text === "string" ? raw.text : "",
      };
    } catch (err) {
      if (err instanceof AppCloudError && err.status === 404) return undefined;
      throw this.wrapCallFailure("云盘文档正文调用失败", err);
    }
  }

  private wrapCallFailure(label: string, err: unknown): AppCloudError {
    if (err instanceof AppCloudError) return err;
    return new AppCloudError(`${label}：${err instanceof Error ? err.message : String(err)}`);
  }

  private normalize(raw: Record<string, unknown>, fallbackUuid: string): CloudSummaryResponse {
    const uploadUuid = optionalText(raw.upload_uuid) ?? fallbackUuid;
    const title = optionalText(raw.title);
    const originalName = optionalText(raw.original_name);
    return {
      upload_uuid: uploadUuid,
      available: raw.available === true,
      stale: raw.stale === true,
      model: typeof raw.model === "string" ? raw.model : "",
      summary: normalizeSummary(raw.summary),
      ...(title !== undefined ? { title } : {}),
      ...(originalName !== undefined ? { original_name: originalName } : {}),
    };
  }
}
