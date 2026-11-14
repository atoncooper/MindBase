import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { AcademicService } from "../src/services/academic.js";
import { ManuscriptDocxService } from "../src/services/manuscript-docx.js";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import { DOCX_MIME } from "../src/doc-parser/docx.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import { AppCloudError, type AppCloudClient } from "../src/clients/app-cloud-client.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";

/**
 * GET /academic/projects/:projectId/files — aggregated project file list
 * (contract: docs/project-files.md §1).
 *
 * Everything runs offline over memory repositories with a fake app-cloud: uid
 * comes from the gateway request context, the service owns the project gate and
 * the tolerance rules (one failed folder = 200, every folder failed = 503), and
 * the route layer only projects the payload + maps errors.
 */

class FakeLiteratureClient implements LiteratureClient {
  async search(_q: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

interface FakeCloudFile {
  upload_uuid: string;
  name: string;
  size: number;
  mime_type: string;
  folder_id: number;
  createdAt?: number;
}

/** In-memory stand-in for AppCloudClient: folder tree + per-folder file listing. */
class FakeCloud {
  configured = true;
  /** Simulates the whole cloud drive being down (every listFiles call fails). */
  failAll = false;
  /** Simulates single folders failing (per-folder outage). */
  readonly failFolderIds = new Set<number>();
  private nextFolderId = 1;
  private readonly files = new Map<string, FakeCloudFile>();

  async createFolder(_uid: string, name: string, parentId?: number) {
    const id = this.nextFolderId++;
    return { id, name, ...(parentId !== undefined ? { parent_id: parentId } : {}) };
  }

  async uploadFile(_uid: string, folderId: number, name: string, data: Uint8Array, mimeType = "application/octet-stream") {
    const upload_uuid = "upload-" + (this.nextFolderId++);
    this.files.set(upload_uuid, { upload_uuid, name, size: data.byteLength, mime_type: mimeType, folder_id: folderId });
    return { upload_uuid, name, size: data.byteLength };
  }

  async downloadFile(_uid: string, uploadUuid: string) {
    const file = this.files.get(uploadUuid);
    if (!file) throw new AppCloudError("文件不存在", 404);
    return { contentType: file.mime_type, data: new Uint8Array(file.size) };
  }

  async deleteFile(): Promise<void> {}

  async listFiles(_uid: string, folderId?: number) {
    if (this.failAll) throw new AppCloudError("云盘服务不可用", 503);
    if (folderId !== undefined && this.failFolderIds.has(folderId)) {
      throw new AppCloudError("目录读取失败", 500);
    }
    const items: FakeCloudFile[] = [];
    for (const file of this.files.values()) {
      if (folderId !== undefined && file.folder_id !== folderId) continue;
      items.push({ ...file });
    }
    return items;
  }

  /** Seeds one file directly into a folder (test helper; no upload call needed). */
  addFile(folderId: number, uploadUuid: string, name: string, opts: { size?: number; mimeType?: string; createdAt?: number } = {}) {
    this.files.set(uploadUuid, {
      upload_uuid: uploadUuid,
      name,
      size: opts.size ?? 1,
      mime_type: opts.mimeType ?? "application/octet-stream",
      folder_id: folderId,
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    });
  }
}

async function buildApp(options: { cloudConfigured?: boolean } = {}) {
  const store = new MemoryAcademicStore();
  const cloud = new FakeCloud();
  if (options.cloudConfigured === false) cloud.configured = false;
  const workspaceRepo = new MemoryResearchWorkspaceRepository();
  const cloudClient = cloud as unknown as AppCloudClient;
  const workspace = new ResearchWorkspaceService(workspaceRepo, cloudClient);
  const manuscriptDocx = new ManuscriptDocxService({
    documents: store,
    projects: store,
    workspace,
    cloud: cloudClient,
  });
  const academic = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: new FakeLiteratureClient(),
  });
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerAcademicRoutes(app, { academic, manuscriptDocx });
  return { app, store, cloud, workspace };
}

const uidOnly = (uid: string) => ({ "x-uid": uid });

/** Creates a project through the REST surface and returns its id. */
async function createProject(app: ReturnType<typeof Fastify>): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/academic/projects",
    headers: { "x-uid": "1", "content-type": "application/json" },
    payload: { title: "文件聚合项目" },
  });
  expect(created.statusCode).toBe(200);
  return created.json().project.id as string;
}

/** Ensures the project workspace tree through the service and returns the folder ids. */
async function ensureWorkspace(
  workspace: ResearchWorkspaceService,
  projectId: string,
): Promise<{ workspaceId: string; folders: Record<string, number> }> {
  const ws = await workspace.ensureProject("1", projectId, "文件聚合项目");
  const project = ws.projects.find((entry) => entry.projectId === projectId);
  expect(project).toBeDefined();
  return { workspaceId: ws.workspaceId, folders: project!.folders };
}

describe("GET /academic/projects/:projectId/files", () => {
  it("requires the gateway uid", async () => {
    const { app } = await buildApp();
    const projectId = await createProject(app);
    const res = await app.inject({ method: "GET", url: "/academic/projects/" + projectId + "/files" });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain("X-Uid");
    await app.close();
  });

  it("lists document source/lastExport entries when the project has no workspace", async () => {
    const { app, store } = await buildApp();
    const projectId = await createProject(app);
    const document = await store.createDocument("1", projectId, {
      kind: "draft",
      title: "无空间稿",
      source: { uploadUuid: "doc-source-1", fileName: "original.docx", mimeType: DOCX_MIME },
    });
    await store.updateDocument("1", document.id, {
      lastExport: { uploadUuid: "doc-export-1", fileName: "回存稿.docx", createdAt: 111 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("1"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspace).toEqual({ exists: false });
    expect(
      body.files.map((file: { uploadUuid: string; origin: string; name: string }) => ({
        uploadUuid: file.uploadUuid,
        origin: file.origin,
        name: file.name,
      })),
    ).toEqual([
      { uploadUuid: "doc-source-1", origin: "document-source", name: "original.docx" },
      { uploadUuid: "doc-export-1", origin: "document-export", name: "回存稿.docx" },
    ]);
    expect(body.files[0].documentId).toBe(document.id);
    expect(body.files[0].documentTitle).toBe("无空间稿");
    expect(body.files[0].mimeType).toBe(DOCX_MIME);
    expect(body.files[1].documentId).toBe(document.id);
    expect(body.files[1].mimeType).toBe(DOCX_MIME);
    expect(body.files[1].createdAt).toBe(111);
    await app.close();
  });

  it("aggregates the seven workspace folders in order, newest first, and dedupes document uploads", async () => {
    const { app, store, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    const { workspaceId, folders } = await ensureWorkspace(workspace, projectId);

    cloud.addFile(folders.plan, "ws-plan", "plan.md", { createdAt: 50 });
    cloud.addFile(folders.data, "ws-data-old", "old.csv", { createdAt: 100 });
    cloud.addFile(folders.data, "ws-data-new", "new.csv", { createdAt: 300 });
    cloud.addFile(folders.manuscript, "ws-manuscript", "paper.docx", { createdAt: 999, mimeType: DOCX_MIME });

    // The document's source points at the very same cloud upload: the workspace
    // row must win and the document-source row must be skipped.
    const imported = await store.createDocument("1", projectId, {
      kind: "draft",
      title: "同源稿",
      source: { uploadUuid: "ws-manuscript", fileName: "paper.docx", mimeType: DOCX_MIME },
    });
    // A document-only export (no workspace twin) is appended after workspace files.
    const exported = await store.createDocument("1", projectId, { kind: "draft", title: "导出稿" });
    await store.updateDocument("1", exported.id, {
      lastExport: { uploadUuid: "doc-export-1", fileName: "导出稿.docx", createdAt: 500 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("1"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.workspace.exists).toBe(true);
    expect(body.workspace.workspaceId).toBe(workspaceId);
    expect(body.workspace.title).toBeTruthy();
    expect(body.workspace.folders).toHaveLength(7);
    expect(body.workspace.folders.map((folder: { kind: string }) => folder.kind)).toEqual([
      "plan",
      "literature",
      "data",
      "code",
      "results",
      "manuscript",
      "submission",
    ]);
    expect(body.workspace.folders.map((folder: { label: string }) => folder.label)).toEqual([
      "00_课题与计划",
      "01_文献",
      "02_数据",
      "03_代码与实验",
      "04_结果",
      "05_论文",
      "06_投稿",
    ]);
    expect(body.workspace.folders[0].folderId).toBe(folders.plan);

    expect(body.files.map((file: { uploadUuid: string }) => file.uploadUuid)).toEqual([
      "ws-plan",
      "ws-data-new",
      "ws-data-old",
      "ws-manuscript",
      "doc-export-1",
    ]);
    const byUuid = new Map(
      body.files.map((file: { uploadUuid: string }) => [file.uploadUuid, file] as const),
    );
    expect(byUuid.get("ws-data-new")!.folderKind).toBe("data");
    expect(byUuid.get("ws-data-new")!.folderLabel).toBe("02_数据");
    expect(byUuid.get("ws-manuscript")!.origin).toBe("workspace");
    expect(byUuid.get("ws-manuscript")!.documentId).toBeUndefined();
    const exportRow = byUuid.get("doc-export-1")!;
    expect(exportRow.origin).toBe("document-export");
    expect(exportRow.documentId).toBe(exported.id);
    expect(exportRow.documentTitle).toBe("导出稿");
    // The duplicate source row was skipped, so the imported document contributes nothing.
    expect(body.files.some((file: { documentId?: string }) => file.documentId === imported.id)).toBe(false);
    await app.close();
  });

  it("stays 200 when one folder listing fails and keeps the other folders", async () => {
    const { app, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    const { folders } = await ensureWorkspace(workspace, projectId);

    cloud.addFile(folders.data, "ws-data", "data.csv", { createdAt: 10 });
    cloud.addFile(folders.results, "ws-result", "result.txt", { createdAt: 20 });
    cloud.failFolderIds.add(folders.data);

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("1"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspace.exists).toBe(true);
    expect(body.files.map((file: { uploadUuid: string }) => file.uploadUuid)).toEqual(["ws-result"]);
    expect(body.files[0].folderKind).toBe("results");
    await app.close();
  });

  it("answers 503 when every workspace folder listing fails (cloud drive down)", async () => {
    const { app, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    await ensureWorkspace(workspace, projectId);
    cloud.failAll = true;

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("1"),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toBe("云盘服务暂不可用，无法读取项目文件");
    await app.close();
  });

  it("answers 503 when the cloud drive is not configured but the project has a workspace", async () => {
    const { app, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    await ensureWorkspace(workspace, projectId);
    cloud.configured = false;

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("1"),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toBe("云盘服务暂不可用，无法读取项目文件");
    await app.close();
  });

  it("answers 404 for a missing or foreign project", async () => {
    const { app } = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/academic/projects/does-not-exist/files",
      headers: uidOnly("1"),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().detail).toContain("项目不存在");

    const projectId = await createProject(app);
    const foreign = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/files",
      headers: uidOnly("999"),
    });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });
});
