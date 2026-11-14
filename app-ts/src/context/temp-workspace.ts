import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("TEMP");

/**
 * TempWorkspaceManager: local scratch files for agent-side document parsing.
 *
 * Lifecycle (the whole point of this module):
 *   tool download → materialize() → parser reads the file → **turn ends** →
 *   ChatService (program lifecycle, never a tool/model) calls disposeRequest().
 *
 * Isolation: one directory per (hashed uid, turn requestId):
 *   <root>/u-<sha256(uid|'anon').slice(0,16)>/turn-<requestId>/
 * Original file names NEVER reach the path (only the display name); the path
 * segment is randomUUID + a sanitized extension. Directories are 0700 and files
 * 0600 so another local user (or another tenant's crash residue) cannot read them.
 *
 * FD safety: a per-turn file/byte budget, a global concurrent-file ceiling and a
 * global write semaphore keep open handles and disk usage bounded; a file is
 * opened 'wx', written and closed immediately (no long-lived fd). Files are
 * counted from the moment a write is reserved and released on dispose/sweep.
 *
 * Crash recovery: directories left behind by a killed process are removed by
 * sweepStale() (startup + periodic, unref'd timer); the TTL is deliberately
 * longer than any single turn (6h).
 *
 * TOOL-FACING SURFACE: tools receive only `TempFileWorkspace` (enabled +
 * materialize). There is deliberately NO delete/dispose method on it — an agent
 * cannot delete its own evidence, and only the program lifecycle cleans up.
 */

export interface TempWorkspaceOptions {
  /** false = tools fall back to in-memory parsing (no local files at all). */
  enabled?: boolean;
  /** Root directory; empty/omitted = os.tmpdir()/mindbase-agent. */
  baseDir?: string;
  /** Files allowed in one turn (default 4). */
  maxFilesPerTurn?: number;
  /** Bytes allowed in one turn (default 64MB). */
  maxBytesPerTurn?: number;
  /** Bytes allowed for one file (default 20MB). */
  maxFileBytes?: number;
  /** Files alive across all turns (default 32). */
  maxGlobalFiles?: number;
  /** Concurrent files being written (default 8). */
  maxConcurrentWrites?: number;
  /** Sweep removes turn directories older than this (default 6h). */
  staleTtlMs?: number;
  /** Periodic sweep interval, 0 = no timer (default 10min). */
  sweepIntervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export const TEMP_WORKSPACE_DEFAULTS = {
  enabled: true,
  maxFilesPerTurn: 4,
  maxBytesPerTurn: 64 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxGlobalFiles: 32,
  maxConcurrentWrites: 8,
  staleTtlMs: 6 * 60 * 60 * 1000,
  sweepIntervalMs: 10 * 60 * 1000,
} as const;

/** Result of writing one scratch file; the caller keeps only the path. */
export type MaterializeResult =
  | { ok: true; path: string; sizeBytes: number; displayName: string }
  | { ok: false; error: string };

/**
 * The ONLY capability exposed to tools: create a file inside the current turn.
 * No delete method exists on purpose — cleanup belongs to the program lifecycle.
 */
export interface TempFileWorkspace {
  readonly enabled: boolean;
  /** Writes bytes into this turn's directory; the file lives until the turn is disposed. */
  materialize(
    requestId: string,
    uid: string | undefined,
    bytes: Uint8Array,
    originalName: string,
    mime?: string,
  ): Promise<MaterializeResult>;
}

interface TurnState {
  /** map key: uidHash + "\u0000" + safe request token */
  key: string;
  requestId: string;
  uidHash: string;
  dir: string;
  createdAt: number;
  files: number;
  bytes: number;
}

/** MIME → extension fallback (only for the display/scratch file name). */
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function mib(bytes: number): string {
  return String(Math.round((bytes / 1024 / 1024) * 10) / 10);
}

/** uid → stable, non-reversible directory segment (raw uid never appears on disk). */
function hashUid(uid: string | undefined): string {
  const value = typeof uid === "string" && uid.trim().length > 0 ? uid.trim() : "anon";
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** requestId → safe path segment; anything unusual is hashed instead of escaped. */
function safeRequestToken(requestId: string): string {
  const trimmed = requestId.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
}

/** Sanitized extension from the original name, falling back to the MIME type. */
function extensionFor(originalName: string, mime: string | undefined): string {
  const base = (originalName ?? "").replace(/^.*[\\/]/, "");
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  if (match) return "." + match[1].toLowerCase();
  const byMime = mime ? EXT_BY_MIME[mime.trim().toLowerCase()] : undefined;
  return byMime ? "." + byMime : "";
}

/**
 * Human-facing name: path components and control characters are stripped, so a
 * hostile original name can only change the label — never the location.
 */
function displayNameFor(originalName: string, ext: string): string {
  const base = (originalName ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .trim();
  const clipped = base.slice(0, 200);
  return clipped.length > 0 ? clipped : "document" + ext;
}

/**
 * Manager instance created once by the composition root. The class implements
 * TempFileWorkspace (the tool-facing view) plus the lifecycle methods only the
 * program calls: disposeRequest / disposeAll / close / sweepStale.
 */
export class TempWorkspaceManager implements TempFileWorkspace {
  readonly enabled: boolean;
  readonly resolvedBaseDir: string;
  private readonly maxFilesPerTurn: number;
  private readonly maxBytesPerTurn: number;
  private readonly maxFileBytes: number;
  private readonly maxGlobalFiles: number;
  private readonly maxConcurrentWrites: number;
  private readonly staleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;

  private readonly turns = new Map<string, TurnState>();
  private totalFiles = 0;
  private totalBytes = 0;
  private activeWrites = 0;
  private waitingWrites = 0;
  private peakActiveWrites = 0;
  private readonly writeWaiters: Array<() => void> = [];
  private timer?: NodeJS.Timeout;

  constructor(options: TempWorkspaceOptions = {}) {
    this.enabled = options.enabled ?? TEMP_WORKSPACE_DEFAULTS.enabled;
    const configured = (options.baseDir ?? "").trim();
    this.resolvedBaseDir = path.resolve(
      configured.length > 0 ? configured : path.join(os.tmpdir(), "mindbase-agent"),
    );
    this.maxFilesPerTurn = positive(options.maxFilesPerTurn, TEMP_WORKSPACE_DEFAULTS.maxFilesPerTurn);
    this.maxBytesPerTurn = positive(options.maxBytesPerTurn, TEMP_WORKSPACE_DEFAULTS.maxBytesPerTurn);
    this.maxFileBytes = positive(options.maxFileBytes, TEMP_WORKSPACE_DEFAULTS.maxFileBytes);
    this.maxGlobalFiles = positive(options.maxGlobalFiles, TEMP_WORKSPACE_DEFAULTS.maxGlobalFiles);
    this.maxConcurrentWrites = positive(options.maxConcurrentWrites, TEMP_WORKSPACE_DEFAULTS.maxConcurrentWrites);
    this.staleTtlMs = positive(options.staleTtlMs, TEMP_WORKSPACE_DEFAULTS.staleTtlMs);
    this.sweepIntervalMs = options.sweepIntervalMs ?? TEMP_WORKSPACE_DEFAULTS.sweepIntervalMs;
    this.now = options.now ?? Date.now;
  }

  /** Startup hook: removes crash residue, then schedules the periodic sweep. */
  async start(): Promise<void> {
    if (!this.enabled) {
      log.info("[TEMP] disabled (tempFiles.enabled=false) — parsing stays in memory");
      return;
    }
    const swept = await this.sweepStale().catch((err: unknown) => {
      log.warn("[TEMP] startup sweep failed: " + (err instanceof Error ? err.message : String(err)));
      return { removed: 0 };
    });
    log.info(
      "[TEMP] workspace root=" + this.resolvedBaseDir +
        " maxFilesPerTurn=" + this.maxFilesPerTurn +
        " maxBytesPerTurn=" + mib(this.maxBytesPerTurn) + "MB" +
        " maxGlobalFiles=" + this.maxGlobalFiles +
        " maxConcurrentWrites=" + this.maxConcurrentWrites +
        " swept=" + swept.removed,
    );
    if (this.sweepIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.sweepStale().catch((err: unknown) => {
          log.warn("[TEMP] periodic sweep failed: " + (err instanceof Error ? err.message : String(err)));
        });
      }, this.sweepIntervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Writes one scratch file inside this turn's directory.
   *
   * Budgets are checked and RESERVED synchronously after the directory exists, so
   * two concurrent calls cannot both slip past the last slot; the reservation is
   * rolled back if the write fails. Expected failures come back as
   * { ok:false, error } guidance instead of throwing.
   */
  async materialize(
    requestId: string,
    uid: string | undefined,
    bytes: Uint8Array,
    originalName: string,
    mime?: string,
  ): Promise<MaterializeResult> {
    if (!this.enabled) {
      return { ok: false, error: "本地临时文件能力已关闭，无法创建临时文件；请直接解析或缩小范围。" };
    }
    const requestToken = (requestId ?? "").trim();
    if (requestToken.length === 0) {
      return { ok: false, error: "当前请求缺少 request id，无法创建临时文件。" };
    }
    const size = bytes?.byteLength ?? 0;
    if (size === 0) return { ok: false, error: "临时文件内容为空，无法解析。" };
    if (size > this.maxFileBytes) {
      return {
        ok: false,
        error: "单个临时文件超过上限（" + mib(this.maxFileBytes) + "MB），请缩小解析范围后重试。",
      };
    }

    await this.acquireWriteSlot();
    try {
      const state = await this.ensureTurn(safeRequestToken(requestToken), requestToken, uid);
      if (!state) return { ok: false, error: "本地临时文件写入失败（无法创建临时目录），请稍后重试。" };
      if (state.files + 1 > this.maxFilesPerTurn) {
        return {
          ok: false,
          error: "本轮临时文件数量已达上限（" + this.maxFilesPerTurn + " 个），请缩小解析范围或分批提问。",
        };
      }
      if (state.bytes + size > this.maxBytesPerTurn) {
        return {
          ok: false,
          error: "本轮临时文件总大小已达上限（" + mib(this.maxBytesPerTurn) + "MB），请缩小解析范围。",
        };
      }
      if (this.totalFiles + 1 > this.maxGlobalFiles) {
        return {
          ok: false,
          error: "系统临时文件额度已满（全局上限 " + this.maxGlobalFiles + " 个），请稍后重试。",
        };
      }

      const ext = extensionFor(originalName, mime);
      const filePath = path.join(state.dir, randomUUID() + ext);
      state.files += 1;
      state.bytes += size;
      this.totalFiles += 1;
      this.totalBytes += size;
      try {
        // 'wx' refuses to overwrite; the handle is closed immediately (no long-lived fd).
        const handle = await fs.open(filePath, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      } catch (err) {
        state.files -= 1;
        state.bytes -= size;
        this.totalFiles -= 1;
        this.totalBytes -= size;
        log.warn("[TEMP] write failed: " + (err instanceof Error ? err.message : String(err)));
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        return { ok: false, error: "本地临时文件写入失败，请稍后重试。" };
      }
      return {
        ok: true,
        path: filePath,
        sizeBytes: size,
        displayName: displayNameFor(originalName, ext),
      };
    } finally {
      this.releaseWriteSlot();
    }
  }

  /**
   * Program-lifecycle cleanup for one request/turn. Idempotent; all matching
   * uid directories of the same requestId are removed (a request can only own
   * one, but a defensive match keeps cleanup complete). Errors are warnings only.
   */
  async disposeRequest(requestId: string): Promise<void> {
    const states = [...this.turns.values()].filter((state) => state.requestId === requestId);
    for (const state of states) {
      this.turns.delete(state.key);
      this.defaultRelease(state);
      await this.removeTurnDir(state.dir);
    }
  }

  /** Cleanup for every tracked turn (graceful shutdown). */
  async disposeAll(): Promise<void> {
    const states = [...this.turns.values()];
    this.turns.clear();
    this.totalFiles = 0;
    this.totalBytes = 0;
    for (const state of states) {
      await this.removeTurnDir(state.dir);
    }
  }

  /** Graceful-shutdown hook: clears the sweep timer and removes tracked turn dirs. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.disposeAll();
  }

  /**
   * Crash recovery + periodic hygiene: removes turn directories whose mtime is
   * older than staleTtlMs, releasing their counters. Scans the filesystem (not
   * just the map) so directories from a previous process are cleaned too.
   */
  async sweepStale(): Promise<{ removed: number }> {
    if (!this.enabled) return { removed: 0 };
    let uidEntries;
    try {
      uidEntries = await fs.readdir(this.resolvedBaseDir, { withFileTypes: true });
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const uidEntry of uidEntries) {
      if (!uidEntry.isDirectory() || !uidEntry.name.startsWith("u-")) continue;
      const uidDir = path.join(this.resolvedBaseDir, uidEntry.name);
      let turnEntries;
      try {
        turnEntries = await fs.readdir(uidDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const turnEntry of turnEntries) {
        if (!turnEntry.isDirectory() || !turnEntry.name.startsWith("turn-")) continue;
        const turnDir = path.join(uidDir, turnEntry.name);
        const age = await this.ageOf(turnDir);
        if (age === undefined || age <= this.staleTtlMs) continue;
        await this.removeTurnDir(turnDir);
        for (const [key, state] of this.turns) {
          if (state.dir !== turnDir) continue;
          this.turns.delete(key);
          this.defaultRelease(state);
        }
        removed += 1;
      }
      // Best-effort: drop the uid directory once it is empty.
      await fs.rmdir(uidDir).catch(() => undefined);
    }
    if (removed > 0) log.info("[TEMP] swept " + removed + " stale turn director" + (removed === 1 ? "y" : "ies"));
    return { removed };
  }

  /** Read-only introspection (diagnostics/tests); exposes no delete capability. */
  stats(): {
    enabled: boolean;
    turns: number;
    files: number;
    bytes: number;
    activeWrites: number;
    waitingWrites: number;
    peakActiveWrites: number;
  } {
    return {
      enabled: this.enabled,
      turns: this.turns.size,
      files: this.totalFiles,
      bytes: this.totalBytes,
      activeWrites: this.activeWrites,
      waitingWrites: this.waitingWrites,
      peakActiveWrites: this.peakActiveWrites,
    };
  }

  // ---- internals ----------------------------------------------------------

  /** Creates/returns the turn directory record; undefined when mkdir failed. */
  private async ensureTurn(token: string, requestId: string, uid: string | undefined): Promise<TurnState | undefined> {
    const uidHash = hashUid(uid);
    const key = uidHash + "\u0000" + token;
    const existing = this.turns.get(key);
    if (existing) return existing;
    const uidDir = path.join(this.resolvedBaseDir, "u-" + uidHash);
    const turnDir = path.join(uidDir, "turn-" + token);
    try {
      await fs.mkdir(this.resolvedBaseDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(uidDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(turnDir, { recursive: true, mode: 0o700 });
      // chmod explicitly: mkdir modes are filtered by umask and do not apply to
      // already-existing directories (crash leftovers).
      await fs.chmod(this.resolvedBaseDir, 0o700).catch(() => undefined);
      await fs.chmod(uidDir, 0o700).catch(() => undefined);
      await fs.chmod(turnDir, 0o700).catch(() => undefined);
    } catch (err) {
      log.warn("[TEMP] ensure turn dir failed: " + (err instanceof Error ? err.message : String(err)));
      return undefined;
    }
    const state: TurnState = {
      key,
      requestId,
      uidHash,
      dir: turnDir,
      createdAt: this.now(),
      files: 0,
      bytes: 0,
    };
    this.turns.set(key, state);
    return state;
  }

  private async ageOf(dir: string): Promise<number | undefined> {
    try {
      const stat = await fs.stat(dir);
      return this.now() - stat.mtimeMs;
    } catch {
      return undefined;
    }
  }

  private defaultRelease(state: TurnState): void {
    this.totalFiles = Math.max(0, this.totalFiles - state.files);
    this.totalBytes = Math.max(0, this.totalBytes - state.bytes);
  }

  private async removeTurnDir(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      log.warn("[TEMP] remove dir failed (" + dir + "): " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    await fs.rmdir(path.dirname(dir)).catch(() => undefined);
  }

  /** Counting semaphore: at most maxConcurrentWrites writes in flight. */
  private async acquireWriteSlot(): Promise<void> {
    while (this.activeWrites >= this.maxConcurrentWrites) {
      this.waitingWrites += 1;
      try {
        await new Promise<void>((resolve) => this.writeWaiters.push(resolve));
      } finally {
        this.waitingWrites -= 1;
      }
    }
    this.activeWrites += 1;
    if (this.activeWrites > this.peakActiveWrites) this.peakActiveWrites = this.activeWrites;
  }

  private releaseWriteSlot(): void {
    this.activeWrites -= 1;
    const next = this.writeWaiters.shift();
    if (next) next();
  }
}

/** Coerce a configured numeric budget; non-finite/non-positive values fall back. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
