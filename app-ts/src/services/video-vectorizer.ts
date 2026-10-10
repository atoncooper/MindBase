import { createHash } from "node:crypto";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { RAGService } from "../rag/service.js";
import type { KgSourceStore } from "../repository/kg-sources.js";
import {
  type VecPageRecord,
  type VecTaskRecord,
  type VecTaskStep,
  type VectorTaskRepository,
  newVecTaskId,
} from "../repository/vector-tasks.js";

const log = createLogger("VEC");

/**
 * Per-page video vectorization — the AI side's successor of the Python
 * VectorPageService. Pipeline per (bvid, cid):
 *   init guard → ASR delegate (app-bili) when content missing → delete old
 *   vectors → chunk + embed + insert (RAGService.addVideoContent, idempotent
 *   delete-then-insert) → bookkeeping done/failed.
 * Task state lives in the vector task repository (Mongo preferred); progress
 * is step-level like the Python tracker. Triggered by the Redis
 * `bili:page_ready` subscriber and by POST /vec/page/create|revector.
 *
 * RED LINE: acquisition (download/ffmpeg/DashScope) stays in app-bili — this
 * service only orchestrates and writes Milvus + its own bookkeeping.
 */

export class VecError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface VecPageStatus {
  exists: boolean;
  bvid?: string;
  cid?: number;
  page_index?: number;
  page_title?: string;
  is_processed: boolean;
  content_preview?: string;
  is_vectorized: "pending" | "processing" | "done" | "failed";
  vectorized_at?: string;
  vector_chunk_count: number;
  vector_error?: string;
}

export interface VecTaskStatus {
  task_id: string;
  status: VecTaskRecord["status"];
  progress: number;
  message: string;
  steps: VecTaskStep[];
  result?: Record<string, unknown>;
  error?: string;
}

/** ASR delegation contract — default implementation calls app-bili over HTTP. */
export interface AsrDelegate {
  ensureAsr(uid: string, bvid: string, cid: number, pageIndex: number, pageTitle: string): Promise<void>;
}

export class VideoVectorizerService {
  private readonly rag: Pick<RAGService, "addVideoContent" | "deletePageVectors" | "deleteVideo">;
  private readonly sources: KgSourceStore;
  private readonly tasks: VectorTaskRepository;
  private readonly asr: AsrDelegate;
  private readonly countPage?: (bvid: string, pageIndex: number) => Promise<number>;
  /** bounded pipeline concurrency (protects the embedding gateway + Milvus) */
  private readonly semaphore: Semaphore;

  constructor(deps: {
    rag: Pick<RAGService, "addVideoContent" | "deletePageVectors" | "deleteVideo">;
    sources: KgSourceStore;
    tasks: VectorTaskRepository;
    asr?: AsrDelegate;
    /** page-level Milvus count (self-heal); absent = heal checks disabled */
    countPageVectors?: (bvid: string, pageIndex: number) => Promise<number>;
  }) {
    this.rag = deps.rag;
    this.sources = deps.sources;
    this.tasks = deps.tasks;
    this.asr = deps.asr ?? new AppBiliAsrDelegate();
    this.countPage = deps.countPageVectors;
    this.semaphore = new Semaphore(Math.max(1, config.vectorize.concurrency));
  }

  /**
   * Idempotent vectorization task. Returns task_id=null with "Already up to
   * date" when the page is done and the ASR content has not changed.
   */
  async createTask(input: {
    uid: string;
    bvid: string;
    cid: number;
    pageIndex?: number;
    pageTitle?: string;
  }): Promise<{ task_id: string | null; message: string }> {
    const { uid, bvid, cid } = input;
    const pageIndex = input.pageIndex ?? 0;
    const transcript = await this.sources.getLatest(bvid, cid);
    const pageTitle = input.pageTitle || transcript?.pageTitle || `P${pageIndex + 1}`;

    const existing = await this.tasks.getPage(bvid, cid);
    if (existing?.status === "done" && existing.contentHash !== undefined) {
      const unchanged = transcript ? existing.contentHash === sha1(transcript.content) : false;
      if (unchanged) {
        return { task_id: null, message: "Already up to date" };
      }
    }

    const record: VecPageRecord = existing ?? {
      bvid,
      cid,
      pageIndex,
      pageTitle,
      status: "pending",
      chunkCount: 0,
      updatedAt: Date.now(),
    };
    record.pageIndex = pageIndex;
    record.pageTitle = pageTitle;
    record.status = "pending";
    record.error = undefined;
    record.updatedAt = Date.now();
    await this.tasks.upsertPage(record);

    const task = this.newTask(uid, bvid, cid, pageIndex, pageTitle);
    await this.tasks.saveTask(task);
    void this.runPipeline(task.taskId, uid, bvid, cid, pageIndex, pageTitle);
    return { task_id: task.taskId, message: "Vectorization task created" };
  }

  /** Force re-vectorization — refuses when no ASR content exists yet. */
  async revector(input: { uid: string; bvid: string; cid: number }): Promise<{ task_id: string; message: string }> {
    const { uid, bvid, cid } = input;
    const transcript = await this.sources.getLatest(bvid, cid);
    if (!transcript || transcript.content.trim().length < 50) {
      const record = await this.tasks.getPage(bvid, cid);
      if (!record) throw new VecError(404, "Video page not found");
      throw new VecError(400, "ASR not completed — cannot vectorize");
    }
    const existing = await this.tasks.getPage(bvid, cid);
    const pageIndex = existing?.pageIndex ?? 0;
    const pageTitle = transcript.pageTitle || existing?.pageTitle || `P${pageIndex + 1}`;
    const record: VecPageRecord = existing ?? {
      bvid, cid, pageIndex, pageTitle, status: "pending", chunkCount: 0, updatedAt: Date.now(),
    };
    record.status = "pending";
    record.error = undefined;
    record.updatedAt = Date.now();
    await this.tasks.upsertPage(record);

    const task = this.newTask(uid, bvid, cid, pageIndex, pageTitle);
    await this.tasks.saveTask(task);
    void this.runPipeline(task.taskId, uid, bvid, cid, pageIndex, pageTitle);
    return { task_id: task.taskId, message: "Re-vectorization task created" };
  }

  /** Page status with the Python service's cross-store self-heal. */
  async pageStatus(bvid: string, cid: number): Promise<VecPageStatus> {
    const record = await this.tasks.getPage(bvid, cid);
    if (!record) {
      return { exists: false, is_processed: false, is_vectorized: "pending", vector_chunk_count: 0 };
    }

    let status = record.status;
    let chunkCount = record.chunkCount;
    const transcript = await this.sources.getLatest(bvid, cid);
    const contentExists = !!transcript && transcript.content.trim().length >= 50;

    // self-heal against Milvus (mirrors Python: DB says done but no vectors → failed)
    if ((status === "done" || status === "pending") && this.countPage) {
      const actual = await this.countPage(bvid, record.pageIndex).catch(() => 0);
      if (status === "done" && actual === 0) {
        status = "failed";
        await this.persistPage({ ...record, status, error: "Milvus vector count is 0 — data lost" });
      } else if (status === "pending" && actual > 0 && contentExists) {
        status = "done";
        chunkCount = actual;
        await this.persistPage({ ...record, status, chunkCount: actual, vectorizedAt: Date.now() });
      }
    }

    return {
      exists: true,
      bvid,
      cid,
      page_index: record.pageIndex,
      page_title: record.pageTitle,
      is_processed: contentExists,
      content_preview: contentExists && transcript ? transcript.content.slice(0, 200) : undefined,
      is_vectorized: status,
      vectorized_at: record.vectorizedAt ? new Date(record.vectorizedAt).toISOString() : undefined,
      vector_chunk_count: chunkCount,
      vector_error: record.error,
    };
  }

  /** Poll pipeline task state; uid ownership enforced (IDOR guard). */
  async taskStatus(taskId: string, uid: string): Promise<VecTaskStatus> {
    const task = await this.tasks.getTask(taskId);
    if (!task) throw new VecError(404, "Task not found");
    if (task.uid && task.uid !== uid) throw new VecError(403, "无权访问此任务");

    let message = "Pending";
    if (task.status === "done") message = "Complete";
    else if (task.status === "failed") message = `Failed: ${task.error || "unknown"}`;
    else if (task.status === "processing") message = "Processing...";

    return {
      task_id: task.taskId,
      status: task.status,
      progress: task.progress,
      message,
      steps: task.steps,
      result: task.result,
      error: task.error,
    };
  }

  /** Delete everything known about a video (vectors + bookkeeping). */
  async deleteVideo(bvid: string): Promise<void> {
    await this.rag.deleteVideo(bvid);
    await this.tasks.deletePagesByBvid(bvid);
  }

  /** Wipe the whole video bookkeeping (admin /knowledge/clear companion). */
  async clearAllPages(): Promise<void> {
    await this.tasks.deleteAllPages();
  }

  /** All done pages (for /knowledge/pages/vectorized joining with the scope). */
  async listDonePages(): Promise<VecPageRecord[]> {
    const all = await this.tasks.listAllPages();
    return all.filter((p) => p.status === "done");
  }

  // ── pipeline ───────────────────────────────────────────────────────

  private newTask(uid: string, bvid: string, cid: number, pageIndex: number, pageTitle: string): VecTaskRecord {
    const now = Date.now();
    return {
      taskId: newVecTaskId(),
      uid,
      bvid,
      cid,
      pageIndex,
      pageTitle,
      status: "pending",
      progress: 0,
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async runPipeline(
    taskId: string,
    uid: string,
    bvid: string,
    cid: number,
    pageIndex: number,
    pageTitle: string,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      await this.start(taskId, "init");
      const record = await this.tasks.getPage(bvid, cid);
      if (!record) throw new Error(`page record missing: bvid=${bvid}, cid=${cid}`);

      // idempotency: done + unchanged content → skip
      const transcript0 = await this.sources.getLatest(bvid, cid);
      if (
        record.status === "done" &&
        record.contentHash !== undefined &&
        transcript0 &&
        record.contentHash === sha1(transcript0.content)
      ) {
        await this.complete(taskId, { skipped: true, message: "Already up to date" }, 100);
        return;
      }
      await this.persistPage({ ...record, status: "processing", error: undefined });
      await this.finishStep(taskId, "init");

      // Phase: ASR (content must exist in Mongo — delegate to app-bili if not)
      let transcript = transcript0;
      if (!transcript || transcript.content.trim().length < 50) {
        await this.start(taskId, "asr");
        await this.asr.ensureAsr(uid, bvid, cid, pageIndex, pageTitle);
        transcript = await this.sources.getLatest(bvid, cid);
        if (!transcript || transcript.content.trim().length < 50) {
          throw new Error(`ASR completed but no content saved for bvid=${bvid}, cid=${cid}`);
        }
        await this.finishStep(taskId, "asr");
      }

      // Phase: replace vectors
      await this.progress(taskId, 40);
      await this.start(taskId, "vec", 30);
      const contentHash = sha1(transcript.content);
      await this.rag.deletePageVectors(bvid, pageIndex).catch((err) => {
        log.warn(`[${bvid}] failed to delete old vectors: ${err instanceof Error ? err.message : err}`);
      });
      await this.progress(taskId, 60);

      const chunkCount = await this.rag.addVideoContent(
        { bvid, cid, title: pageTitle, content: transcript.content, source: "asr" },
        pageIndex,
        pageTitle,
      );
      await this.finishStep(taskId, "vec");

      const done = await this.tasks.getPage(bvid, cid);
      await this.persistPage({
        ...(done ?? record),
        status: "done",
        chunkCount,
        contentHash,
        error: undefined,
        vectorizedAt: Date.now(),
      });
      await this.complete(taskId, { chunk_count: chunkCount }, 100);
      log.info(`[VEC] done bvid=${bvid} cid=${cid} page=${pageIndex} chunks=${chunkCount}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[VEC] failed bvid=${bvid} cid=${cid}: ${message}`);
      await this.fail(taskId, message);
      const record = await this.tasks.getPage(bvid, cid);
      if (record) {
        await this.persistPage({ ...record, status: "failed", error: message });
      }
    } finally {
      release();
    }
  }

  private async persistPage(record: VecPageRecord): Promise<void> {
    await this.tasks.upsertPage({ ...record, updatedAt: Date.now() });
  }

  private async loadTask(taskId: string): Promise<VecTaskRecord | undefined> {
    return this.tasks.getTask(taskId);
  }

  private async start(taskId: string, name: string, progress = 0): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;
    task.status = "processing";
    task.progress = Math.max(task.progress, progress);
    task.steps = [...task.steps, { name, status: "processing", progress: 0, at: Date.now() }];
    task.updatedAt = Date.now();
    await this.tasks.saveTask(task);
  }

  private async finishStep(taskId: string, name: string, progress = 100): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;
    task.steps = task.steps.map((s) => (s.name === name && s.status === "processing" ? { ...s, status: "done", progress } : s));
    task.updatedAt = Date.now();
    await this.tasks.saveTask(task);
  }

  private async progress(taskId: string, value: number): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;
    task.progress = value;
    task.updatedAt = Date.now();
    await this.tasks.saveTask(task);
  }

  private async complete(taskId: string, result: Record<string, unknown>, progress: number): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;
    task.status = "done";
    task.progress = progress;
    task.result = result;
    task.error = undefined;
    task.updatedAt = Date.now();
    await this.tasks.saveTask(task);
  }

  private async fail(taskId: string, error: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;
    task.status = "failed";
    task.error = error;
    task.updatedAt = Date.now();
    await this.tasks.saveTask(task);
  }
}

// ── ASR delegation (app-bili) — mirrors the Python service's HTTP flow ──

export class AppBiliAsrDelegate implements AsrDelegate {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts?: { baseUrl?: string; timeoutMs?: number; pollIntervalMs?: number }) {
    this.baseUrl = (opts?.baseUrl ?? config.appBili.baseUrl).replace(/\/$/, "");
    this.timeoutMs = opts?.timeoutMs ?? config.vectorize.asrTimeoutMs;
    this.pollIntervalMs = opts?.pollIntervalMs ?? config.vectorize.pollIntervalMs;
  }

  async ensureAsr(uid: string, bvid: string, cid: number, pageIndex: number, pageTitle: string): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (uid && uid !== "0") headers["X-Uid"] = uid;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl}/asr/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ bvid, cid, page_index: pageIndex, page_title: pageTitle }),
      signal: timeout,
    });
    if (!res.ok) throw new Error(`app-bili /asr/create HTTP ${res.status}`);
    const created = (await res.json()) as { task_id?: string; status?: string };
    if (created.status === "done") return;
    if (!created.task_id) throw new Error("app-bili /asr/create returned no task_id");

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const st = await fetch(`${this.baseUrl}/asr/status/${created.task_id}`, {
        headers,
        signal: timeout,
      });
      if (!st.ok) throw new Error(`app-bili /asr/status HTTP ${st.status}`);
      const body = (await st.json()) as { status?: string; message?: string };
      if (body.status === "done") return;
      if (body.status === "failed") throw new Error(`ASR failed: ${body.message ?? "unknown"}`);
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`ASR timed out after ${Math.round(this.timeoutMs / 1000)}s: bvid=${bvid}, cid=${cid}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
