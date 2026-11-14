import { describe, expect, it } from "vitest";
import { ResearchExperimentRunner } from "../src/services/research-experiment.js";
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
