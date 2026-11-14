import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { buildDocxBuffer } from "../src/services/docx-writer.js";
import { DOCX_MIME, parseDocxSections } from "../src/doc-parser/docx.js";
import { ManuscriptDocxService } from "../src/services/manuscript-docx.js";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import { AcademicService } from "../src/services/academic.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import { AppCloudError, type AppCloudClient } from "../src/clients/app-cloud-client.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";
import { createResearchWorkspaceTool } from "../src/tools/academic/workspace.js";
import { MemorySessionDocumentStore } from "../src/repository/memory/session-docs.js";
import { createMemoryChatImageStorage } from "../src/repository/memory/chat-images.js";

/**
 * Import-from-cloud + parser enhancement + agent tool tests (task: template
 * import / workspace read_file):
 *  - POST /academic/projects/:projectId/documents/import-from-cloud
 *  - parseDocxSections plain-text (Chinese/numbered) heading boundaries
 *  - academic_manuscript(action=import_docx)
 *  - research_workspace(action=read_file)
 *
 * Everything runs offline over memory repositories with a fake app-cloud.
 */

class FakeLiteratureClient implements LiteratureClient {
  async search(_q: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

interface StoredFile {
  upload_uuid: string;
  name: string;
  data: Uint8Array;
  mimeType: string;
  folderId: number;
  createdAt?: number;
}

/** In-memory stand-in for AppCloudClient: folder tree, uploads, downloads, listings. */
class FakeCloud {
  configured = true;
  uploadCalls = 0;
  private nextFolderId = 1;
  readonly files = new Map<string, StoredFile>();

  async createFolder(_uid: string, name: string, parentId?: number) {
    return { id: this.nextFolderId++, name, ...(parentId !== undefined ? { parent_id: parentId } : {}) };
  }

  async uploadFile(_uid: string, folderId: number, name: string, data: Uint8Array, mimeType = "application/octet-stream") {
    this.uploadCalls += 1;
    const upload_uuid = "upload-" + this.nextFolderId++;
    this.files.set(upload_uuid, { upload_uuid, name, data: new Uint8Array(data), mimeType, folderId });
    return { upload_uuid, name, size: data.byteLength };
  }

  /** Seeds one file directly (test helper; no upload call is counted). */
  addFile(folderId: number, uploadUuid: string, name: string, data: Uint8Array, mimeType = DOCX_MIME): void {
    this.files.set(uploadUuid, {
      upload_uuid: uploadUuid,
      name,
      data: new Uint8Array(data),
      mimeType,
      folderId,
      createdAt: 1,
    });
  }

  async downloadFile(_uid: string, uploadUuid: string) {
    const file = this.files.get(uploadUuid);
    if (!file) throw new AppCloudError("文件不存在", 404);
    return { contentType: file.mimeType, data: file.data };
  }

  async deleteFile(): Promise<void> {}

  async listFiles(_uid: string, folderId?: number) {
    const items: Array<{
      upload_uuid: string;
      name: string;
      size: number;
      mime_type: string;
      folder_id: number;
      createdAt?: number;
    }> = [];
    for (const file of this.files.values()) {
      if (folderId !== undefined && file.folderId !== folderId) continue;
      items.push({
        upload_uuid: file.upload_uuid,
        name: file.name,
        size: file.data.byteLength,
        mime_type: file.mimeType,
        folder_id: file.folderId,
        ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
      });
    }
    return items;
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
  return { app, store, cloud, workspace, manuscriptDocx };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });

/** Creates a project through the REST surface and returns its id. */
async function createProject(app: ReturnType<typeof Fastify>): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/academic/projects",
    headers: asUid("1"),
    payload: { title: "云盘导入项目" },
  });
  expect(created.statusCode).toBe(200);
  return created.json().project.id as string;
}

/** Ensures the project workspace tree and returns the folder ids. */
async function ensureWorkspace(
  workspace: ResearchWorkspaceService,
  projectId: string,
): Promise<Record<string, number>> {
  const ws = await workspace.ensureProject("1", projectId, "云盘导入项目");
  const project = ws.projects.find((entry) => entry.projectId === projectId);
  expect(project).toBeDefined();
  return project!.folders;
}

describe("POST /academic/projects/:projectId/documents/import-from-cloud", () => {
  it("imports an existing project cloud .docx without re-uploading it", async () => {
    const { app, store, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    const folders = await ensureWorkspace(workspace, projectId);
    const docx = await buildDocxBuffer({
      title: "云盘模板稿",
      sections: [
        { title: "摘要", content: "摘要正文" },
        { title: "方法", content: "方法正文" },
      ],
    });
    cloud.addFile(folders.manuscript, "cloud-docx-1", "模板.docx", docx);

    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "cloud-docx-1", kind: "revision" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.document.title).toBe("云盘模板稿");
    expect(body.document.kind).toBe("revision");
    expect(body.document.sections.map((section: { title: string }) => section.title)).toEqual(["摘要", "方法"]);
    expect(body.source.uploadUuid).toBe("cloud-docx-1");
    expect(body.source.fileName).toBe("模板.docx");
    expect(body.source.mimeType).toBe(DOCX_MIME);
    expect(body.source.folderId).toBe(folders.manuscript);
    // The cloud file is reused as-is: nothing was uploaded again.
    expect(cloud.uploadCalls).toBe(0);

    const stored = await store.getDocument("1", body.document.id);
    expect(stored?.source?.uploadUuid).toBe("cloud-docx-1");
    await app.close();
  });

  it("accepts an explicit title override", async () => {
    const { app, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    const folders = await ensureWorkspace(workspace, projectId);
    const docx = await buildDocxBuffer({ title: "原稿标题", sections: [{ title: "摘要", content: "x" }] });
    cloud.addFile(folders.manuscript, "cloud-docx-2", "原稿.docx", docx);

    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "cloud-docx-2", title: "自定义标题" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.title).toBe("自定义标题");
    await app.close();
  });

  it("rejects a missing uploadUuid with 422", async () => {
    const { app } = await buildApp();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("uploadUuid");
    await app.close();
  });

  it("answers 404 for a missing project and for a missing cloud file", async () => {
    const { app, workspace } = await buildApp();
    const missingProject = await app.inject({
      method: "POST",
      url: "/academic/projects/does-not-exist/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "nope" },
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json().detail).toContain("项目不存在");

    const projectId = await createProject(app);
    await ensureWorkspace(workspace, projectId);
    const missingFile = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "does-not-exist" },
    });
    expect(missingFile.statusCode).toBe(404);
    expect(missingFile.json().detail).toContain("云盘文件不存在");
    await app.close();
  });

  it("answers 503 when the cloud drive is not configured", async () => {
    const { app } = await buildApp({ cloudConfigured: false });
    const projectId = await createProject(app);
    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "any" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain("云盘服务暂不可用");
    await app.close();
  });

  it("rejects a non-docx cloud file and an unparsable .docx with 422", async () => {
    const { app, cloud, workspace } = await buildApp();
    const projectId = await createProject(app);
    const folders = await ensureWorkspace(workspace, projectId);
    cloud.addFile(folders.data, "csv-1", "data.csv", Buffer.from("a,b\n1,2"), "text/csv");
    cloud.addFile(folders.manuscript, "broken-1", "broken.docx", Buffer.from("not a zip"));

    const csv = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "csv-1" },
    });
    expect(csv.statusCode).toBe(422);
    expect(csv.json().detail).toContain(".docx");

    const broken = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import-from-cloud",
      headers: asUid("1"),
      payload: { uploadUuid: "broken-1" },
    });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().detail).toContain("解析失败");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// parseDocxSections: plain-text heading boundaries
// ---------------------------------------------------------------------------

describe("parseDocxSections plain-text headings", () => {
  it("treats Chinese/numbered paragraphs as level-2 section boundaries", async () => {
    const buffer = await buildDocxBuffer({
      title: "增强解析稿",
      sections: [
        {
          title: "引言",
          content:
            "一、研究背景\n背景正文。\n第一章 方法\n方法正文。\n1. 实验设置\n设置正文。\n（一）、研究目标\n目标正文。",
        },
      ],
    });
    const parsed = await parseDocxSections(buffer);
    expect(parsed.title).toBe("增强解析稿");
    // The heading text is kept verbatim (numbering included): the parser only
    // decides where a section starts, it does not rewrite the user's headings.
    expect(parsed.sections.map((section) => section.title)).toEqual([
      "引言",
      "一、研究背景",
      "第一章 方法",
      "1. 实验设置",
      "（一）、研究目标",
    ]);
    expect(parsed.sections[1].content).toBe("背景正文。");
    expect(parsed.sections[2].content).toBe("方法正文。");
    expect(parsed.sections[3].content).toBe("设置正文。");
    expect(parsed.sections[4].content).toBe("目标正文。");
  });

  it("does not split prose that only looks like a heading", async () => {
    const longLine = "第一章 " + "这是一段很长的正文内容".repeat(6);
    expect(longLine.length).toBeGreaterThan(40);
    const buffer = await buildDocxBuffer({
      title: "误判边界稿",
      sections: [{ title: "正文", content: "一、二线城市差异明显。\n第一章。\n" + longLine }],
    });
    const parsed = await parseDocxSections(buffer);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].title).toBe("正文");
    expect(parsed.sections[0].content).toContain("一、二线城市差异明显。");
    expect(parsed.sections[0].content).toContain(longLine);
  });
});

// ---------------------------------------------------------------------------
// academic_manuscript(action=import_docx)
// ---------------------------------------------------------------------------

function toolCtx(): ToolRunContext {
  return { uid: "1", scope: {}, collector: new ResultCollector() };
}

describe("academic_manuscript import_docx", () => {
  it("delegates the cloud import to the injected Word service and reports the document", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "导入工具项目" });
    const document = await store.createDocument("1", project.id, {
      kind: "draft",
      title: "导入稿",
      sections: [
        { title: "摘要", content: "摘要正文" },
        { title: "方法", content: "方法正文" },
      ],
    });
    const calls: Array<{ uid: string; projectId: string; input: { uploadUuid: string; title?: string; kind?: string } }> = [];
    const tool = createAcademicManuscriptTool({
      documents: store,
      projects: store,
      events: store,
      docx: {
        exportDocxToCloud: async () => {
          throw new Error("not used in this test");
        },
        importDocxFromCloud: async (uid: string, projectId: string, input: { uploadUuid: string; title?: string; kind?: string }) => {
          calls.push({ uid, projectId, input });
          return {
            document,
            source: { uploadUuid: input.uploadUuid, fileName: "模板.docx", mimeType: DOCX_MIME },
          };
        },
      },
    });
    const ctx = toolCtx();
    const output = String(
      await tool.execute({ action: "import_docx", projectId: project.id, uploadUuid: "cloud-1" }, ctx),
    );
    expect(output).toContain("导入稿");
    expect(output).toContain(document.id);
    expect(output).toContain("模板.docx");
    expect(output).toContain("uploadUuid: cloud-1");
    expect(calls).toEqual([{ uid: "1", projectId: project.id, input: { uploadUuid: "cloud-1" } }]);
    const artifact = ctx.collector.artifacts.filter((item) => item.kind === "academic_manuscript").pop();
    expect((artifact?.data as { action?: string }).action).toBe("import_docx");
    expect((artifact?.data as { source?: { uploadUuid?: string } }).source?.uploadUuid).toBe("cloud-1");
  });

  it("asks for uploadUuid and degrades when the Word service is absent", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "导入工具项目" });
    const tool = createAcademicManuscriptTool({ documents: store, projects: store, events: store });
    const missing = String(await tool.execute({ action: "import_docx", projectId: project.id }, toolCtx()));
    expect(missing).toContain("uploadUuid");

    const noService = String(
      await tool.execute({ action: "import_docx", projectId: project.id, uploadUuid: "cloud-1" }, toolCtx()),
    );
    expect(noService).toContain("未启用");
  });
});

// ---------------------------------------------------------------------------
// academic_manuscript import_docx — conversation uploads (no second upload)
// ---------------------------------------------------------------------------

describe("academic_manuscript import_docx from a conversation upload", () => {
  /** Wires the tool with the real attachment/session-document stores + fake cloud. */
  async function buildTool() {
    const built = await buildApp();
    const projectId = await createProject(built.app);
    const folders = await ensureWorkspace(built.workspace, projectId);
    const chatFiles = createMemoryChatImageStorage();
    const sessionDocs = new MemorySessionDocumentStore();
    const tool = createAcademicManuscriptTool({
      documents: built.store,
      projects: built.store,
      events: built.store,
      docx: built.manuscriptDocx,
      sessionDocs,
      sessionFiles: chatFiles,
    });
    const ctx = (): ToolRunContext => ({
      uid: "1",
      chatSessionId: "sess-1",
      scope: {},
      collector: new ResultCollector(),
    });
    return { ...built, projectId, folders, chatFiles, sessionDocs, tool, ctx };
  }

  it("imports the .docx uploaded in chat and copies its original into the project cloud drive", async () => {
    const { app, store, cloud, projectId, folders, chatFiles, sessionDocs, tool, ctx } = await buildTool();
    const docx = await buildDocxBuffer({
      title: "开题报告",
      sections: [
        { title: "一、研究背景", content: "背景正文" },
        { title: "二、研究内容", content: "内容正文" },
      ],
    });
    const stored = await chatFiles.putFile("sess-1", "开题报告.docx", docx, DOCX_MIME);
    const meta = await sessionDocs.save("sess-1", "开题报告.docx", ["开题报告 片段"], docx.byteLength, stored);

    const output = String(await tool.execute({ action: "import_docx", projectId, sessionDocument: meta.id }, ctx()));
    expect(output).toContain("已从本会话上传导入 Word 模板");
    expect(output).toContain("开题报告");
    // The chat upload became the project cloud-drive template: no second upload was asked from the user.
    expect(cloud.uploadCalls).toBe(1);
    const copied = [...cloud.files.values()].find((file) => file.name === "开题报告.docx");
    expect(copied?.folderId).toBe(folders.manuscript);
    const docs = await store.listDocuments("1", projectId);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("开题报告");
    expect(docs[0].sections.map((section) => section.title)).toEqual(["一、研究背景", "二、研究内容"]);
    await app.close();
  });

  it("resolves by filename and explains missing original, non-docx and unknown documents", async () => {
    const { app, chatFiles, sessionDocs, tool, projectId, ctx } = await buildTool();
    const docx = await buildDocxBuffer({ title: "模板", sections: [{ title: "摘要", content: "x" }] });
    const stored = await chatFiles.putFile("sess-1", "有原件.docx", docx, DOCX_MIME);
    await sessionDocs.save("sess-1", "有原件.docx", ["片段"], docx.byteLength, stored);
    // No file argument = legacy/non-durable row: the original was never kept.
    await sessionDocs.save("sess-1", "无原件.docx", ["片段"], docx.byteLength);
    await sessionDocs.save("sess-1", "说明.md", ["片段"], 10);

    const byName = String(await tool.execute({ action: "import_docx", projectId, sessionDocument: "有原件.docx" }, ctx()));
    expect(byName).toContain("有原件.docx");
    expect(byName).toContain("已从本会话上传导入");

    const noOriginal = String(await tool.execute({ action: "import_docx", projectId, sessionDocument: "无原件.docx" }, ctx()));
    expect(noOriginal).toContain("原件没有留存");

    const nonDocx = String(await tool.execute({ action: "import_docx", projectId, sessionDocument: "说明.md" }, ctx()));
    expect(nonDocx).toContain("不是 .docx");

    const unknown = String(await tool.execute({ action: "import_docx", projectId, sessionDocument: "不存在.docx" }, ctx()));
    expect(unknown).toContain("本会话没有名为");
    await app.close();
  });

  it("lists the conversation Word uploads when no source is given", async () => {
    const { app, sessionDocs, tool, projectId, ctx } = await buildTool();
    const docx = await buildDocxBuffer({ title: "模板", sections: [{ title: "摘要", content: "x" }] });
    await sessionDocs.save("sess-1", "开题报告.docx", ["片段"], docx.byteLength);

    const output = String(await tool.execute({ action: "import_docx", projectId }, ctx()));
    expect(output).toContain("sessionDocument");
    expect(output).toContain("开题报告.docx");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// research_workspace(action=read_file)
// ---------------------------------------------------------------------------

describe("research_workspace read_file", () => {
  async function buildTool() {
    const cloud = new FakeCloud();
    const repo = new MemoryResearchWorkspaceRepository();
    const service = new ResearchWorkspaceService(repo, cloud as unknown as AppCloudClient);
    const ws = await service.createWorkspace("1", "读文件空间");
    const workspace = await service.ensureProject("1", "proj-1", "读文件课题", ws.workspaceId);
    const project = workspace.projects.find((entry) => entry.projectId === "proj-1")!;
    const tool = createResearchWorkspaceTool(service);
    return { tool, cloud, folders: project.folders };
  }

  it("extracts docx text (title + sections) by upload_uuid", async () => {
    const { tool, cloud, folders } = await buildTool();
    const docx = await buildDocxBuffer({
      title: "模板标题",
      sections: [{ title: "摘要", content: "摘要正文" }],
    });
    cloud.addFile(folders.manuscript, "docx-1", "模板.docx", docx);

    const output = String(
      await tool.execute({ action: "read_file", projectId: "proj-1", uploadUuid: "docx-1" }, toolCtx()),
    );
    expect(output).toContain("文件：模板.docx");
    expect(output).toContain("目录 manuscript");
    expect(output).toContain("upload_uuid=docx-1");
    expect(output).toContain("模板标题");
    expect(output).toContain("摘要正文");
  });

  it("reads md/txt by name and truncates long text to 8000 chars", async () => {
    const { tool, cloud, folders } = await buildTool();
    cloud.addFile(folders.literature, "md-1", "说明.md", Buffer.from("# 说明\n正文内容", "utf8"), "text/markdown");
    const longText = "字".repeat(10_000);
    cloud.addFile(folders.data, "txt-1", "长文.txt", Buffer.from(longText, "utf8"), "text/plain");

    const md = String(await tool.execute({ action: "read_file", projectId: "proj-1", name: "说明.md" }, toolCtx()));
    expect(md).toContain("# 说明");
    expect(md).toContain("正文内容");

    const txt = String(await tool.execute({ action: "read_file", projectId: "proj-1", name: "长文.txt" }, toolCtx()));
    expect(txt).toContain("已截断");
    expect(txt).toContain("全文 10000 字");
    expect(txt).toContain("仅显示前 8000 字");
  });

  it("answers guidance for unsupported types and missing files", async () => {
    const { tool, cloud, folders } = await buildTool();
    cloud.addFile(folders.results, "png-1", "图.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");

    const png = String(await tool.execute({ action: "read_file", projectId: "proj-1", name: "图.png" }, toolCtx()));
    expect(png).toContain("暂不支持文本读取");

    const missing = String(
      await tool.execute({ action: "read_file", projectId: "proj-1", name: "不存在.md" }, toolCtx()),
    );
    expect(missing).toContain("没有找到文件");
  });
});
