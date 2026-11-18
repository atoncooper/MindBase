import { describe, expect, it } from "vitest";
import { config } from "../src/config/index.js";
import {
  ResearchExperimentDuplicateError,
  ResearchExperimentQueueFullError,
  ResearchExperimentRunner,
} from "../src/services/research/research-experiment.js";
import { MemoryResearchExperimentRepository } from "../src/repository/memory/research-experiments.js";
import type { CodeExecutionPort, CodeExecutionResult } from "../src/tools/code/code-execution.js";

function port(result: CodeExecutionResult): CodeExecutionPort {
  return { run: async () => result };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout waiting for experiment");
}

describe("ResearchExperimentRunner", () => {
 it("submits, executes in background and calls the callback", async () => {
    const repo = new MemoryResearchExperimentRepository();
    const callbacks: string[] = [];
    const runner = new ResearchExperimentRunner(
      repo,
      port({ ok: true, stdout: "acc=0.9", stderr: "", sandboxAvailable: true, exitCode: 0 }),
      1,
    );
    runner.setCallback(async (exp) => {
      callbacks.push(exp.id + ":" + exp.status);
    });
    const submitted = await runner.submit({
      uid: "1",
      projectId: "p1",
      chatSessionId: "s1",
      language: "python",
      code: "print(1)",
      timeoutMs: 5000,
    });
    expect(["queued", "running"]).toContain(submitted.status);
    await waitFor(async () => (await repo.get(submitted.id))?.status === "succeeded");
    const persisted = await repo.get(submitted.id);
    expect(persisted?.stdoutPreview).toContain("acc=0.9");
    expect(callbacks).toEqual([submitted.id + ":succeeded"]);
  });

 it("marks queued/running rows interrupted on boot and calls back", async () => {
    const repo = new MemoryResearchExperimentRepository();
    await repo.create({
      id: "exp1",
      uid: "1",
      projectId: "p1",
      language: "python",
      code: "print(1)",
      timeoutMs: 5000,
      status: "running",
      createdAt: 1,
      startedAt: 2,
    });
    const callbacks: string[] = [];
    const runner = new ResearchExperimentRunner(
      repo,
      port({ ok: true, stdout: "", stderr: "", sandboxAvailable: true }),
    );
    runner.setCallback(async (exp) => {
      callbacks.push(exp.status);
    });
    await runner.reconcileInterrupted();
    const persisted = await repo.get("exp1");
    expect(persisted?.status).toBe("interrupted");
    expect(callbacks).toEqual(["interrupted"]);
  });
});

describe("ResearchExperimentRunner hardening ", () => {
 it("rejects a submit when the per-user queue is full", async () => {
    const repo = new MemoryResearchExperimentRepository();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: CodeExecutionPort = {
      run: async () => {
        await gate;
        return { ok: true, stdout: "", stderr: "", sandboxAvailable: true, exitCode: 0 };
      },
    };
    // maxQueued=1: one running + no queue slot left.
    const saved = config.academic.experiments.maxQueued;
    config.academic.experiments.maxQueued = 1;
    try {
      const runner = new ResearchExperimentRunner(repo, slow, 1, undefined);
      await runner.submit({ uid: "1", projectId: "p1", language: "python", code: "print(1)", timeoutMs: 5000 });
      await expect(
        runner.submit({ uid: "1", projectId: "p1", language: "python", code: "print(2)", timeoutMs: 5000 }),
      ).rejects.toBeInstanceOf(ResearchExperimentQueueFullError);
    } finally {
      config.academic.experiments.maxQueued = saved;
      release?.();
    }
  });

 it("dedupes an identical running experiment instead of submitting twice", async () => {
    const repo = new MemoryResearchExperimentRepository();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ResearchExperimentRunner(
      repo,
      { run: async () => { await gate; return { ok: true, stdout: "", stderr: "", sandboxAvailable: true, exitCode: 0 }; } },
      1,
    );
    await runner.submit({ uid: "1", projectId: "p1", language: "python", code: "same", timeoutMs: 5000 });
    await expect(
      runner.submit({ uid: "1", projectId: "p1", language: "python", code: "same", timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(ResearchExperimentDuplicateError);
    release?.();
  });

 it("cancels a queued experiment before it starts (callback still fires once)", async () => {
    const repo = new MemoryResearchExperimentRepository();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ResearchExperimentRunner(
      repo,
      { run: async () => { await gate; return { ok: true, stdout: "", stderr: "", sandboxAvailable: true, exitCode: 0 }; } },
      1,
    );
    const callbacks: string[] = [];
    runner.setCallback(async (exp) => callbacks.push(exp.status));
    const first = await runner.submit({ uid: "1", projectId: "p1", language: "python", code: "a", timeoutMs: 5000 });
    const second = await runner.submit({ uid: "1", projectId: "p1", language: "python", code: "b", timeoutMs: 5000 });
    expect(await runner.cancel(second.id)).toBe(true);
    const persisted = await repo.get(second.id);
    expect(persisted?.status).toBe("cancelled");
    expect(callbacks).toContain("cancelled");
    release?.();
    await waitFor(async () => (await repo.get(first.id))?.status === "succeeded");
  });

 it("records sandbox artifacts and notifies the callback once", async () => {
    const repo = new MemoryResearchExperimentRepository();
    const runner = new ResearchExperimentRunner(
      repo,
      {
        run: async () => ({
          ok: true,
          stdout: "",
          stderr: "",
          sandboxAvailable: true,
          exitCode: 0,
          artifacts: [{ name: "figure.png", sizeBytes: 12, sha256: "abc", url: "https://example.invalid/f.png" }],
        }),
      },
      1,
    );
    let callbacks = 0;
    runner.setCallback(async () => {
      callbacks += 1;
    });
    const submitted = await runner.submit({ uid: "1", projectId: "p1", language: "python", code: "plot", timeoutMs: 5000 });
    await waitFor(async () => (await repo.get(submitted.id))?.status === "succeeded");
    const persisted = await repo.get(submitted.id);
    expect(persisted?.artifacts?.[0]?.name).toBe("figure.png");
    expect(persisted?.callbackNotifiedAt).toBeDefined();
    expect(callbacks).toBe(1);
  });
});