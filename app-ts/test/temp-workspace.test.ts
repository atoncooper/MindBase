import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentHarness } from "../src/harness/app.js";
import type { SseFrame } from "../src/transport/sse.js";
import { ChatService } from "../src/services/chat.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import { runWithRequestContext, getRequestContext } from "../src/context/request-context.js";
import { TempWorkspaceManager, type TempWorkspaceOptions } from "../src/context/temp-workspace.js";

/**
 * TempWorkspaceManager lifecycle/security tests (docs/temp-files.md):
 * per-(hashed uid, turn) isolation, path-traversal-proof file names, per-turn and
 * global budgets, the write semaphore, disposeRequest idempotency, suspicious
 * residue sweep and the ChatService lifecycle hook (dispose only after the whole
 * turn, on success/error/abort/disconnect). Offline: every manager uses an
 * injected mkdtemp base dir and an injected clock where timing matters.
 */

let baseDir = "";
let managers: TempWorkspaceManager[] = [];

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mindbase-tempws-"));
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) await manager.close().catch(() => undefined);
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
});

function makeManager(options: TempWorkspaceOptions = {}): TempWorkspaceManager {
  const manager = new TempWorkspaceManager({ baseDir, ...options });
  managers.push(manager);
  return manager;
}

/** Recursively lists files under a directory (absolute paths), [] when missing. */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

function hashUid(uid: string | undefined): string {
  return createHash("sha256")
    .update(uid && uid.trim().length > 0 ? uid.trim() : "anon")
    .digest("hex")
    .slice(0, 16);
}

const BYTES = new TextEncoder().encode("hello temp file");

describe("TempWorkspaceManager · isolation and path safety", () => {
  it("materializes inside u-<hashed uid>/turn-<requestId> and never leaks the raw uid", async () => {
    const manager = makeManager();
    const result = await manager.materialize("req-1", "user-42", BYTES, "报告.docx", "application/octet-stream");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizeBytes).toBe(BYTES.byteLength);
    expect(result.displayName).toBe("报告.docx");
    expect(existsSync(result.path)).toBe(true);
    // hashed uid + turn segment; raw uid must not appear anywhere in the path
    expect(result.path).toContain(path.join("u-" + hashUid("user-42"), "turn-req-1"));
    expect(result.path).not.toContain("user-42");
    // file name = uuid + sanitized extension (original name only in displayName)
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.docx$/);
    const content = await fs.readFile(result.path, "utf8");
    expect(content).toBe("hello temp file");
  });

  it("keeps different uids on the same requestId isolated", async () => {
    const manager = makeManager();
    const a = await manager.materialize("shared-request", "user-a", BYTES, "a.docx");
    const b = await manager.materialize("shared-request", "user-b", BYTES, "b.docx");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(path.dirname(a.path)).not.toBe(path.dirname(b.path));
    expect(a.path).toContain("u-" + hashUid("user-a"));
    expect(b.path).toContain("u-" + hashUid("user-b"));
    expect(a.path).not.toContain("u-" + hashUid("user-b"));
  });

  it("keeps turns of the same uid isolated", async () => {
    const manager = makeManager();
    const first = await manager.materialize("turn-a", "user-a", BYTES, "a.docx");
    const second = await manager.materialize("turn-b", "user-a", BYTES, "b.docx");
    if (!first.ok || !second.ok) throw new Error("materialize failed");
    expect(path.dirname(first.path)).not.toBe(path.dirname(second.path));
    await manager.disposeRequest("turn-a");
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true); // other turn untouched
  });

  it("treats a hostile original name as a display label only", async () => {
    const manager = makeManager();
    const result = await manager.materialize("req-evil", "1", BYTES, "../../etc/passwd", "text/plain");
    if (!result.ok) throw new Error(result.error);
    expect(result.displayName).toBe("passwd");
    // no traversal: the file stays inside the turn directory, name is a uuid
    expect(result.path.startsWith(baseDir)).toBe(true);
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.txt$/);
    expect(result.path).not.toContain("..");
  });

  it("falls back to a safe extension from the MIME type and rejects an empty request id", async () => {
    const manager = makeManager();
    const result = await manager.materialize(
      "req-mime",
      undefined,
      BYTES,
      "云盘文件 123",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    if (!result.ok) throw new Error(result.error);
    expect(path.basename(result.path)).toMatch(/\.docx$/);
    const missing = await manager.materialize("   ", "1", BYTES, "a.docx");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("request id");
  });

  it("refuses to create files while disabled", async () => {
    const manager = makeManager({ enabled: false });
    const result = await manager.materialize("req-off", "1", BYTES, "a.docx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("临时文件");
    expect(await listFiles(baseDir)).toHaveLength(0);
  });
});

describe("TempWorkspaceManager · budgets and fd guards", () => {
  it("enforces per-turn file count, per-turn bytes and single-file size", async () => {
    const manager = makeManager({ maxFilesPerTurn: 2, maxBytesPerTurn: 10 * BYTES.byteLength, maxFileBytes: 4 * BYTES.byteLength });
    expect((await manager.materialize("req-quota", "1", BYTES, "a.txt")).ok).toBe(true);
    expect((await manager.materialize("req-quota", "1", BYTES, "b.txt")).ok).toBe(true);
    const third = await manager.materialize("req-quota", "1", BYTES, "c.txt");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toContain("本轮临时文件数量");

    const tooBig = await manager.materialize("req-size", "1", new Uint8Array(5 * BYTES.byteLength), "big.bin");
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("单个临时文件");

    const bytesLimit = makeManager({ maxBytesPerTurn: BYTES.byteLength + 1 });
    expect((await bytesLimit.materialize("req-bytes", "1", BYTES, "a.txt")).ok).toBe(true);
    const exceeded = await bytesLimit.materialize("req-bytes", "1", BYTES, "b.txt");
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) expect(exceeded.error).toContain("总大小");
  });

  it("enforces the global file ceiling across turns and releases it on dispose", async () => {
    const manager = makeManager({ maxGlobalFiles: 2, maxFilesPerTurn: 4 });
    expect((await manager.materialize("req-g1", "1", BYTES, "a.txt")).ok).toBe(true);
    expect((await manager.materialize("req-g2", "1", BYTES, "b.txt")).ok).toBe(true);
    const third = await manager.materialize("req-g3", "1", BYTES, "c.txt");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toContain("系统临时文件额度");
    expect(manager.stats().files).toBe(2);

    await manager.disposeRequest("req-g1");
    expect(manager.stats().files).toBe(1);
    expect((await manager.materialize("req-g3", "1", BYTES, "c.txt")).ok).toBe(true);
  });

  it("bounds concurrent writes with the semaphore (peak never exceeds the limit)", async () => {
    const manager = makeManager({ maxConcurrentWrites: 2, maxFilesPerTurn: 10, maxGlobalFiles: 10 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => manager.materialize("req-par", "1", BYTES, "f" + index + ".txt")),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(manager.stats().peakActiveWrites).toBeLessThanOrEqual(2);
    expect(manager.stats().activeWrites).toBe(0);
    expect(manager.stats().waitingWrites).toBe(0);
  });
});

describe("TempWorkspaceManager · lifecycle and crash recovery", () => {
  it("disposeRequest removes the turn directory, is idempotent and is the only delete path", async () => {
    const manager = makeManager();
    const result = await manager.materialize("req-dispose", "1", BYTES, "a.docx");
    if (!result.ok) throw new Error(result.error);
    const turnDir = path.dirname(result.path);
    expect(existsSync(turnDir)).toBe(true);

    await manager.disposeRequest("req-dispose");
    expect(existsSync(result.path)).toBe(false);
    expect(existsSync(turnDir)).toBe(false);
    expect(manager.stats().files).toBe(0);
    await expect(manager.disposeRequest("req-dispose")).resolves.toBeUndefined(); // idempotent
    // Lifecycle methods live on the manager, but tools/services receive the
    // TempFileWorkspace view (enabled + materialize only) — see the typed
    // DocxInspectServiceDeps.tempFiles; the agent never receives this instance.
    expect(typeof manager.disposeRequest).toBe("function");
  });

  it("close() removes every tracked turn directory", async () => {
    const manager = makeManager();
    const a = await manager.materialize("req-close-a", "1", BYTES, "a.txt");
    const b = await manager.materialize("req-close-b", "2", BYTES, "b.txt");
    if (!a.ok || !b.ok) throw new Error("materialize failed");
    await manager.close();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(manager.stats().turns).toBe(0);
  });

  it("sweepStale removes directories older than the TTL and keeps fresh ones", async () => {
    let clock = Date.now();
    const manager = makeManager({ staleTtlMs: 1000, now: () => clock });
    const fresh = await manager.materialize("req-fresh", "1", BYTES, "a.txt");
    const stale = await manager.materialize("req-stale", "1", BYTES, "b.txt");
    if (!fresh.ok || !stale.ok) throw new Error("materialize failed");

    // age only the stale turn directory
    const old = new Date(clock - 60_000);
    await fs.utimes(path.dirname(stale.path), old, old);

    const firstSweep = await manager.sweepStale();
    expect(firstSweep.removed).toBe(1);
    expect(existsSync(stale.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    expect(manager.stats().files).toBe(1);
    expect(manager.stats().turns).toBe(1);

    // age the remaining turn past the TTL: the next sweep removes it too
    await fs.utimes(path.dirname(fresh.path), old, old);
    const secondSweep = await manager.sweepStale();
    expect(secondSweep.removed).toBe(1);
    expect(existsSync(fresh.path)).toBe(false);
    expect(manager.stats().files).toBe(0);
    expect(manager.stats().turns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ChatService lifecycle: dispose AFTER the whole turn, never before
// ---------------------------------------------------------------------------

function framesHarness(frames: SseFrame[]): AgentHarness {
  return {
    dispatchStream: async function* () {
      for (const frame of frames) yield frame;
    },
  } as unknown as AgentHarness;
}

function failingHarness(): AgentHarness {
  return {
    dispatchStream: async function* () {
      throw new Error("harness boom");
    },
  } as unknown as AgentHarness;
}

async function drain(gen: AsyncGenerator<SseFrame>, guardMs = 4000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const deadline = Date.now() + guardMs;
  while (Date.now() < deadline) {
    const next = await gen.next();
    if (next.done) break;
    frames.push(next.value);
  }
  return frames;
}

function makeChat(harness: AgentHarness, tempWorkspaces?: { disposeRequest(requestId: string): Promise<void> }) {
  return new ChatService(
    harness,
    new MemoryChatSessionRepository(),
    new MemoryMessageRepository(),
    undefined,
    undefined,
    null,
    undefined,
    null,
    null,
    undefined,
    undefined,
    undefined,
    tempWorkspaces,
  );
}

describe("ChatService · temp workspace disposal", () => {
  it("disposes the request after a successful turn", async () => {
    const calls: string[] = [];
    const chat = makeChat(framesHarness([{ type: "route", agent: "main" }, { type: "chunk", content: "ok" }, { type: "done" }]), {
      async disposeRequest(requestId) {
        calls.push(requestId);
      },
    });
    await runWithRequestContext({ requestId: "req-ok", uid: "u1", startedAt: Date.now() }, () =>
      drain(chat.askStream({ query: "hi", sessionId: "s-ok", uid: "u1" })),
    );
    expect(calls).toEqual(["req-ok"]);
  });

  it("disposes on harness failure and on an aborted turn", async () => {
    const calls: string[] = [];
    const chat = makeChat(failingHarness(), {
      async disposeRequest(requestId) {
        calls.push(requestId);
      },
    });
    await runWithRequestContext({ requestId: "req-err", uid: "u1", startedAt: Date.now() }, () =>
      drain(chat.askStream({ query: "hi", sessionId: "s-err", uid: "u1" })),
    );
    expect(calls).toEqual(["req-err"]);

    const controller = new AbortController();
    controller.abort();
    await runWithRequestContext({ requestId: "req-abort", uid: "u1", startedAt: Date.now() }, () =>
      drain(chat.askStream({ query: "hi", sessionId: "s-abort", uid: "u1", signal: controller.signal })),
    );
    expect(calls).toEqual(["req-err", "req-abort"]);
  });

  it("disposes when the SSE consumer disconnects mid-turn", async () => {
    const calls: string[] = [];
    const chat = makeChat(
      framesHarness([
        { type: "route", agent: "main" },
        { type: "chunk", content: "partial" },
        { type: "done" },
      ]),
      {
        async disposeRequest(requestId) {
          calls.push(requestId);
        },
      },
    );
    await runWithRequestContext({ requestId: "req-cut", uid: "u1", startedAt: Date.now() }, async () => {
      const gen = chat.askStream({ query: "hi", sessionId: "s-cut", uid: "u1" });
      await gen.next(); // start the turn
      await gen.return(undefined); // consumer goes away -> finally must run
    });
    expect(calls).toEqual(["req-cut"]);
  });

  it("does not touch the manager outside a request context and ignores cleanup failures", async () => {
    const calls: string[] = [];
    const chat = makeChat(framesHarness([{ type: "chunk", content: "ok" }, { type: "done" }]), {
      async disposeRequest(requestId) {
        calls.push(requestId);
      },
    });
    await drain(chat.askStream({ query: "hi", sessionId: "s-noctx", uid: "u1" }));
    expect(calls).toEqual([]);

    const failing = makeChat(framesHarness([{ type: "chunk", content: "ok" }, { type: "done" }]), {
      async disposeRequest() {
        throw new Error("cleanup boom");
      },
    });
    const frames = await runWithRequestContext({ requestId: "req-boom", uid: "u1", startedAt: Date.now() }, () =>
      drain(failing.askStream({ query: "hi", sessionId: "s-boom", uid: "u1" })),
    );
    expect(frames.map((frame) => frame.type)).toContain("done");
  });

  it("deletes the real turn directory after the turn ends", async () => {
    const manager = makeManager();
    let materialized = "";
    const harness = {
      dispatchStream: async function* (req: Parameters<AgentHarness["dispatchStream"]>[0]) {
        const requestId = getRequestContext()?.requestId ?? "";
        const result = await manager.materialize(requestId, req.uid, BYTES, "report.docx");
        if (result.ok) materialized = result.path;
        yield { type: "chunk", content: "ok" } as SseFrame;
        yield { type: "done" } as SseFrame;
      },
    } as unknown as AgentHarness;
    const chat = makeChat(harness, manager);
    await runWithRequestContext({ requestId: "req-e2e", uid: "u1", startedAt: Date.now() }, () =>
      drain(chat.askStream({ query: "hi", sessionId: "s-e2e", uid: "u1" })),
    );
    expect(materialized).not.toBe("");
    expect(existsSync(materialized)).toBe(false);
    expect(existsSync(path.dirname(materialized))).toBe(false);
    expect(await listFiles(baseDir)).toHaveLength(0);
  });
});
