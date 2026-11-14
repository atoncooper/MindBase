import { describe, expect, it } from "vitest";
import {
  buildFileArtifact,
  MAX_CHANGE_LINES,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_URL_CHARS,
  type FileArtifactData,
} from "../src/artifacts/file.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { DOCX_MIME } from "../src/doc-parser/docx.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";
import type { CodeExecutionPort, CodeExecutionResult } from "../src/tools/code/code-execution.js";
import { createRunCodeTool } from "../src/tools/code/index.js";

/**
 * kind="file" artifacts: the builder contract (field limits, enum, URL/uploadUuid
 * safety) and the two producers that emit cards today (run_code sandbox files,
 * academic_manuscript export_docx). Offline only — no sandbox, no cloud drive.
 */

function makeCtx(uid = "1"): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

/** Scripted port: replays one canned result; the request itself is not inspected here. */
function fakeExec(result: CodeExecutionResult): CodeExecutionPort {
  return {
    async run() {
      return result;
    },
  };
}

const OK_RESULT: CodeExecutionResult = {
  ok: true,
  stdout: "saved result.py\n",
  stderr: "",
  sandboxAvailable: true,
  executionId: "exec-1",
  exitCode: 0,
  artifacts: [{ name: "result.py", sizeBytes: 12, url: "https://x/y" }],
};

describe("buildFileArtifact", () => {
  it("builds a generated file card with the documented shape", () => {
    const result = buildFileArtifact({ name: "report.csv", description: "本周统计", sizeBytes: 2048 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.kind).toBe("file");
    const data = result.artifact.data as FileArtifactData;
    expect(data.version).toBe(1);
    expect(data.name).toBe("report.csv");
    expect(data.action).toBe("generated");
    expect(data.sizeBytes).toBe(2048);
    expect(data.description).toBe("本周统计");
    expect(data.url).toBeUndefined();
    expect(data.uploadUuid).toBeUndefined();
  });

  it("keeps every optional field when valid", () => {
    const result = buildFileArtifact({
      name: "  fill_taskbook.py  ",
      description: "补全任务书",
      action: "edited",
      url: "https://minio.local/presigned/x",
      uploadUuid: "upload_123-abc",
      mime: "text/x-python",
      sizeBytes: 0,
      change: { added: 2, removed: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.artifact.data as FileArtifactData;
    expect(data.name).toBe("fill_taskbook.py");
    expect(data.action).toBe("edited");
    expect(data.change).toEqual({ added: 2, removed: 2 });
    expect(data.uploadUuid).toBe("upload_123-abc");
    expect(data.sizeBytes).toBe(0);
  });

  it("rejects an empty or over-long name", () => {
    expect(buildFileArtifact({ name: "   " }).ok).toBe(false);
    const long = buildFileArtifact({ name: "a".repeat(MAX_NAME_CHARS + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toContain(String(MAX_NAME_CHARS));
  });

  it("rejects an over-long description", () => {
    const result = buildFileArtifact({ name: "a.txt", description: "d".repeat(MAX_DESCRIPTION_CHARS + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("description");
  });

  it("rejects unknown actions", () => {
    const result = buildFileArtifact({ name: "a.txt", action: "deleted" as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("action");
  });

  it("rejects unsafe or over-long urls", () => {
    expect(buildFileArtifact({ name: "a.txt", url: "javascript:alert(1)" }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", url: "https://x/" + "y".repeat(MAX_URL_CHARS) }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", url: "/api/files/1" }).ok).toBe(true);
    expect(buildFileArtifact({ name: "a.txt", url: "http://minio.local/x" }).ok).toBe(true);
  });

  it("rejects uploadUuid outside [A-Za-z0-9_-]", () => {
    expect(buildFileArtifact({ name: "a.docx", uploadUuid: "../../etc/passwd" }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.docx", uploadUuid: "u?x=1" }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.docx", uploadUuid: "abc_DEF-123" }).ok).toBe(true);
  });

  it("rejects negative, non-integer or oversized sizeBytes / change counts", () => {
    expect(buildFileArtifact({ name: "a.txt", sizeBytes: -1 }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", sizeBytes: Number.NaN }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", change: { added: -1, removed: 0 } }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", change: { added: 1.5, removed: 0 } }).ok).toBe(false);
    expect(buildFileArtifact({ name: "a.txt", change: { added: MAX_CHANGE_LINES + 1, removed: 0 } }).ok).toBe(false);
  });
});

describe("run_code file artifacts", () => {
  it("turns succeeded sandbox artifacts into kind=file cards", async () => {
    const output = await createRunCodeTool(fakeExec(OK_RESULT)).execute(
      { language: "python", code: "open('result.py','w').write('hi')" },
      makeCtx(),
    );
    expect(typeof output).not.toBe("string");
    if (typeof output === "string") return;
    // The ReAct text still lists the artifact so the model knows it exists.
    expect(output.content).toContain("artifacts (1):");
    expect(output.artifacts).toHaveLength(1);
    const artifact = output.artifacts?.[0];
    expect(artifact?.kind).toBe("file");
    const data = artifact?.data as FileArtifactData;
    expect(data.version).toBe(1);
    expect(data.name).toBe("result.py");
    expect(data.action).toBe("generated");
    expect(data.mime).toBe("text/x-python");
    expect(data.sizeBytes).toBe(12);
    expect(data.url).toBe("https://x/y");
    expect(data.description).toBe("由沙箱代码生成");
  });

  it("stays a plain string when the run produced no artifacts", async () => {
    const output = await createRunCodeTool(fakeExec({ ...OK_RESULT, artifacts: [] })).execute(
      { language: "python", code: "print(1)" },
      makeCtx(),
    );
    expect(typeof output).toBe("string");
  });

  it("does not offer files from a failed run", async () => {
    const output = await createRunCodeTool(fakeExec({ ...OK_RESULT, ok: false, exitCode: 1 })).execute(
      { language: "python", code: "raise SystemExit(1)" },
      makeCtx(),
    );
    expect(typeof output).toBe("string");
  });

  it("caps file cards at 4 and maps known extensions to MIME", async () => {
    const output = await createRunCodeTool(
      fakeExec({
        ...OK_RESULT,
        artifacts: [
          { name: "a.png", sizeBytes: 1 },
          { name: "b.json", sizeBytes: 2 },
          { name: "c.csv", sizeBytes: 3 },
          { name: "d.pdf", sizeBytes: 4 },
          { name: "e.docx", sizeBytes: 5 },
          { name: "unknown.bin", sizeBytes: 6 },
        ],
      }),
    ).execute({ language: "python", code: "pass" }, makeCtx());
    expect(typeof output).not.toBe("string");
    if (typeof output === "string") return;
    expect(output.artifacts).toHaveLength(4);
    const mimes = (output.artifacts ?? []).map((item) => (item.data as FileArtifactData).mime);
    expect(mimes).toEqual(["image/png", "application/json", "text/csv", "application/pdf"]);
  });
});

describe("academic_manuscript export_docx file card", () => {
  it("returns a kind=file card next to the manuscript artifact", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "工具项目" });
    const document = await store.createDocument("1", project.id, { kind: "draft", title: "工具稿" });
    const ctx = makeCtx();
    const tool = createAcademicManuscriptTool({
      documents: store,
      projects: store,
      events: store,
      docx: {
        exportDocxToCloud: async () => ({
          uploadUuid: "cloud-1",
          fileName: "工具稿_202611121200.docx",
          folderId: 5,
          createdAt: 1,
        }),
      },
    });

    const output = await tool.execute({ action: "export_docx", projectId: project.id, documentId: document.id }, ctx);
    expect(typeof output).not.toBe("string");
    if (typeof output === "string") return;
    expect(output.content).toContain("工具稿_202611121200.docx");
    const fileCard = (output.artifacts ?? []).find((item) => item.kind === "file");
    const data = fileCard?.data as FileArtifactData;
    expect(data.name).toBe("工具稿_202611121200.docx");
    expect(data.action).toBe("exported");
    expect(data.uploadUuid).toBe("cloud-1");
    expect(data.mime).toBe(DOCX_MIME);
    expect(data.description).toContain("05_论文");
    // The manuscript JSON artifact still reaches the collector; the file card is
    // only returned in the tool output (the runtime pushes it, so pushing it here
    // as well would duplicate the card).
    const kinds = ctx.collector.artifacts.map((item) => item.kind);
    expect(kinds).toContain("academic_manuscript");
    expect(kinds).not.toContain("file");
  });

  it("keeps the plain-text shape when the Word service is not injected", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "工具项目" });
    const document = await store.createDocument("1", project.id, { kind: "draft", title: "工具稿" });
    const tool = createAcademicManuscriptTool({ documents: store, projects: store, events: store });
    const output = await tool.execute(
      { action: "export_docx", projectId: project.id, documentId: document.id },
      makeCtx(),
    );
    expect(typeof output).toBe("string");
  });
});
