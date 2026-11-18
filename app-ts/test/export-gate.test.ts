import { describe, expect, it, vi } from "vitest";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import type { AppCloudClient } from "../src/clients/app-cloud-client.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { AcademicService } from "../src/services/research/academic.js";
import { ManuscriptDocxService } from "../src/services/research/manuscript-docx.js";
import type { ResearchValidationReport } from "../src/services/research/research-validation.js";
import { ResearchWorkspaceService } from "../src/services/research/research-workspace.js";
import { createAcademicManuscriptTool, type AcademicManuscriptToolDeps } from "../src/tools/academic/manuscript.js";

/**
 * Export gate tests : every export path validates first,
 * refuses with the Chinese failure list unless force is set, and records an
 * export.forced event when it is. Offline throughout: memory repositories, a
 * validation double and a fake cloud drive; no Mongo/Milero/network.
 */

const UID = "u1";

/** Report double: pass by default; the failing one covers every hard-failure list. */
function passingReport(): ResearchValidationReport {
  return {
    pass: true,
    citations: { total: 0, missing: [], unverified: [] },
    runs: { total: 0, unreproducible: [], invalidRefs: [] },
    results: { sections: [], withoutEvidenceRef: [] },
    sectionsWithNumbers: [],
    sectionsMissingRunRef: [],
  };
}

function failingReport(): ResearchValidationReport {
  return {
    pass: false,
    citations: { total: 2, missing: ["ghost2024"], unverified: ["zhang2024"] },
    runs: { total: 1, unreproducible: [], invalidRefs: ["fake-run"] },
    results: { sections: ["结果"], withoutEvidenceRef: ["结果"] },
    sectionsWithNumbers: ["结果"],
    sectionsMissingRunRef: [],
  };
}

/** Validation double: counts guard invocations and returns a fixed report. */
function validationReturning(report: ResearchValidationReport) {
  return { validate: vi.fn(async () => report) };
}

const OK_DOCX = { uploadUuid: "upload-1", fileName: "初稿.docx", folderId: 5, createdAt: 1 };

function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

function makeCtx(): ToolRunContext {
  return { uid: UID, scope: {}, collector: new ResultCollector() };
}

/** Seeds one project + one manuscript in a fresh memory store. */
async function seedStore() {
  const store = new MemoryAcademicStore();
  const project = await store.create(UID, { title: "联邦学习隐私预算" });
  const document = await store.createDocument(UID, project.id, {
    kind: "draft",
    title: "初稿",
    sections: [
      { key: "introduction", title: "引言", content: "隐私预算分配是核心问题 [zhang2024]。" },
      { key: "results", title: "结果", content: "准确率 0.92。" },
    ],
  });
  return { store, project, document };
}

/** Builds the manuscript tool over the memory store, with optional injected ports. */
function manuscriptTool(
  store: MemoryAcademicStore,
  extra: Partial<AcademicManuscriptToolDeps> = {},
) {
  return createAcademicManuscriptTool({ documents: store, projects: store, events: store, ...extra });
}

// ---------------------------------------------------------------------------
// academic_manuscript tool: export_markdown / export_latex / export_docx
// ---------------------------------------------------------------------------

describe("academic_manuscript export gate", () => {
 it("keeps legacy ungated exports when no validation service is injected", async () => {
    const { store, project, document } = await seedStore();
    const tool = manuscriptTool(store);
    const ctx = makeCtx();
    const output = contentOf(
      await tool.execute({ action: "export_markdown", projectId: project.id, documentId: document.id }, ctx),
    );
    expect(output).toContain("# 初稿");
    expect(output).not.toContain("导出已拒绝");
    expect(ctx.collector.artifacts).toHaveLength(1);
  });

 it("refuses text exports with the failure lists when validation fails", async () => {
    const { store, project, document } = await seedStore();
    const validation = validationReturning(failingReport());
    const tool = manuscriptTool(store, { validation });
    for (const action of ["export_markdown", "export_latex"] as const) {
      const ctx = makeCtx();
      const output = contentOf(
        await tool.execute({ action, projectId: project.id, documentId: document.id }, ctx),
      );
      expect(output).toContain("导出已拒绝");
      expect(output).toContain("缺失引用（missing）");
      expect(output).toContain("ghost2024");
      expect(output).toContain("未核验引用（unverified）");
      expect(output).toContain("无效实验引用（invalidRefs）");
      expect(output).toContain("fake-run");
      expect(output).toContain("结果章节缺少证据引用（withoutEvidenceRef）");
      expect(output).not.toContain("# 初稿");
      expect(output).not.toContain("\\documentclass");
      expect(ctx.collector.artifacts).toHaveLength(0);
    }
    expect(validation.validate).toHaveBeenCalledTimes(2);
    expect(validation.validate).toHaveBeenCalledWith(UID, project.id, document.id);
  });

 it("exports when validation passes", async () => {
    const { store, project, document } = await seedStore();
    const validation = validationReturning(passingReport());
    const tool = manuscriptTool(store, { validation });
    const output = contentOf(
      await tool.execute({ action: "export_latex", projectId: project.id, documentId: document.id }, makeCtx()),
    );
    expect(output).toContain("\\documentclass");
    expect(output).not.toContain("导出已拒绝");
    expect(validation.validate).toHaveBeenCalledTimes(1);
  });

 it("force exports and appends an export.forced event", async () => {
    const { store, project, document } = await seedStore();
    const validation = validationReturning(failingReport());
    const tool = manuscriptTool(store, { validation });
    const output = contentOf(
      await tool.execute(
        { action: "export_markdown", projectId: project.id, documentId: document.id, force: true },
        makeCtx(),
      ),
    );
    expect(output).toContain("# 初稿");
    const forced = (await store.listEvents(UID, project.id, 50)).find(
      (event) => event.type === "export.forced",
    );
    expect(forced?.payload.documentId).toBe(document.id);
    expect(forced?.payload.format).toBe("markdown");
    expect(forced?.payload.missing).toEqual(["ghost2024"]);
    expect(forced?.payload.invalidRefs).toEqual(["fake-run"]);
    expect(forced?.actor).toBe("agent");
  });

 it("gates export_docx and passes force through to the Word service", async () => {
    const { store, project, document } = await seedStore();
    const exportDocx = vi.fn(async () => OK_DOCX);
    const tool = manuscriptTool(store, {
      docx: { exportDocxToCloud: exportDocx } as never,
      validation: validationReturning(failingReport()),
    });

    const rejected = contentOf(
      await tool.execute({ action: "export_docx", projectId: project.id, documentId: document.id }, makeCtx()),
    );
    expect(rejected).toContain("导出已拒绝");
    expect(exportDocx).not.toHaveBeenCalled();

    const ctx = makeCtx();
    const forced = contentOf(
      await tool.execute(
        { action: "export_docx", projectId: project.id, documentId: document.id, force: true },
        ctx,
      ),
    );
    expect(forced).toContain("已生成 Word");
    expect(exportDocx).toHaveBeenCalledWith(UID, document.id, { force: true });
    expect(ctx.collector.artifacts.length).toBeGreaterThan(0);
    const eventTypes = (await store.listEvents(UID, project.id, 50)).map((event) => event.type);
    expect(eventTypes).toContain("export.forced");
  });
});

// ---------------------------------------------------------------------------
// AcademicService.exportDocument: 409 on failure, force override, pass path
// ---------------------------------------------------------------------------

class FakeLiteratureClient implements LiteratureClient {
  async search(_query: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

async function seedService(validation?: { validate: () => Promise<ResearchValidationReport> }) {
  const { store, project, document } = await seedStore();
  const service = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: new FakeLiteratureClient(),
    ...(validation ? { validation } : {}),
  });
  return { store, project, document, service };
}

describe("AcademicService export gate", () => {
 it("refuses text export with a 409 detail list when validation fails", async () => {
    const { store, project, document, service } = await seedService(validationReturning(failingReport()));
    await expect(service.exportDocument(UID, document.id, "markdown")).rejects.toMatchObject({ status: 409 });
    const error = await service.exportDocument(UID, document.id, "latex").catch((err: Error) => err);
    expect(error.message).toContain("导出被拒绝");
    expect(error.message).toContain("invalidRefs");
    expect(error.message).toContain("fake-run");
    expect(await store.listEvents(UID, project.id, 50)).toHaveLength(0);
  });

 it("keeps the unknown-format 400 ahead of the gate", async () => {
    const { document, service } = await seedService(validationReturning(failingReport()));
    await expect(service.exportDocument(UID, document.id, "pdf")).rejects.toMatchObject({ status: 400 });
  });

 it("force bypasses the gate and records an export.forced user event", async () => {
    const { store, project, document, service } = await seedService(validationReturning(failingReport()));
    const result = await service.exportDocument(UID, document.id, "markdown", { force: true });
    expect(result.text).toContain("# 初稿");
    const forced = (await store.listEvents(UID, project.id, 50)).find(
      (event) => event.type === "export.forced",
    );
    expect(forced?.payload.format).toBe("markdown");
    expect(forced?.payload.invalidRefs).toEqual(["fake-run"]);
    expect(forced?.actor).toBe("user");
  });

 it("exports normally when validation passes", async () => {
    const { store, project, document, service } = await seedService(validationReturning(passingReport()));
    const result = await service.exportDocument(UID, document.id, "latex");
    expect(result.text).toContain("\\documentclass");
    expect((await store.listEvents(UID, project.id, 50)).some((event) => event.type === "export.forced")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ManuscriptDocxService.exportDocxToCloud: gate before any cloud write
// ---------------------------------------------------------------------------

/** In-memory stand-in for AppCloudClient: folders, uploads and listing only. */
class FakeCloud {
  configured = true;
  private nextFolderId = 1;
  private nextUpload = 1;
  readonly uploads = new Map<string, { name: string; data: Uint8Array; mimeType: string; folderId: number }>();

  async createFolder(_uid: string, name: string) {
    return { id: this.nextFolderId++, name };
  }

  async uploadFile(
    _uid: string,
    folderId: number,
    name: string,
    data: Uint8Array,
    mimeType = "application/octet-stream",
  ) {
    const upload_uuid = "upload-" + this.nextUpload++;
    this.uploads.set(upload_uuid, { name, data: new Uint8Array(data), mimeType, folderId });
    return { upload_uuid, name, size: data.byteLength };
  }

  async listFiles() {
    return [...this.uploads].map(([upload_uuid, file]) => ({
      upload_uuid,
      name: file.name,
      size: file.data.byteLength,
      mime_type: file.mimeType,
      folder_id: file.folderId,
      createdAt: 0,
    }));
  }

  async downloadFile(): Promise<{ contentType: string; data: Uint8Array }> {
    throw new Error("no Word template in this fixture");
  }

  async deleteFile(): Promise<void> {}
}

async function seedDocxService(validation?: { validate: () => Promise<ResearchValidationReport> }) {
  const { store, project, document } = await seedStore();
  const cloud = new FakeCloud();
  const cloudClient = cloud as unknown as AppCloudClient;
  const workspace = new ResearchWorkspaceService(new MemoryResearchWorkspaceRepository(), cloudClient);
  const service = new ManuscriptDocxService({
    documents: store,
    projects: store,
    workspace,
    cloud: cloudClient,
    ...(validation ? { validation } : {}),
  });
  return { store, project, document, cloud, service };
}

describe("ManuscriptDocxService export gate", () => {
 it("refuses to save Word to the cloud drive when validation fails", async () => {
    const { document, cloud, service } = await seedDocxService(validationReturning(failingReport()));
    await expect(service.exportDocxToCloud(UID, document.id)).rejects.toMatchObject({ status: 409 });
    expect(cloud.uploads.size).toBe(0);
  });

 it("force lets the Word save through", async () => {
    const { store, document, cloud, service } = await seedDocxService(validationReturning(failingReport()));
    const result = await service.exportDocxToCloud(UID, document.id, { force: true });
    expect(result.fileName.endsWith(".docx")).toBe(true);
    expect(cloud.uploads.size).toBe(1);
    const saved = await store.getDocument(UID, document.id);
    expect(saved?.lastExport?.uploadUuid).toBe(result.uploadUuid);
  });

 it("saves Word normally when validation passes", async () => {
    const { document, cloud, service } = await seedDocxService(validationReturning(passingReport()));
    const result = await service.exportDocxToCloud(UID, document.id);
    expect(result.fileName.endsWith(".docx")).toBe(true);
    expect(cloud.uploads.size).toBe(1);
  });
});
