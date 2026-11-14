import Fastify from "fastify";
import multipart from "@fastify/multipart";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { buildDocxBuffer } from "../src/services/docx-writer.js";
import { DOCX_MIME, parseDocxSections } from "../src/doc-parser/docx.js";
import { ManuscriptDocxService } from "../src/services/manuscript-docx.js";
import { AcademicService } from "../src/services/academic.js";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { AppCloudError, type AppCloudClient } from "../src/clients/app-cloud-client.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";

/**
 * Word round-trip tests (contract: docs/manuscript-docx.md).
 *
 * Covers the OOXML module in isolation (generate -> unzip -> inspect; template
 * reuse keeps styles.xml byte-identical and carries the page setup;
 * parse(build(...)) round-trip) and the three /academic/* Word routes over a
 * real ManuscriptDocxService with a fake app-cloud + in-memory repositories
 * (no network, no Mongo, no MinIO).
 */

/** Exact paragraph-style markup, so assertions never embed quote-juggled XML. */
const pStyle = (styleId: string): string => "<w:pStyle w:val=\"" + styleId + "\"/>";
/** Run markup that keeps leading/trailing spaces intact. */
const preserveRun = "<w:t xml:space=\"preserve\">";

/** In-memory stand-in for AppCloudClient: folders, uploads and downloads only. */
class FakeCloud {
  configured = true;
  failDownloadStatus: number | undefined;
  private nextFolderId = 1;
  private nextUpload = 1;
  readonly folders: Array<{ id: number; name: string; parentId?: number }> = [];
  readonly uploads = new Map<string, { name: string; data: Uint8Array; mimeType: string; folderId: number }>();

  async createFolder(_uid: string, name: string, parentId?: number) {
    const id = this.nextFolderId++;
    this.folders.push({ id, name, ...(parentId !== undefined ? { parentId } : {}) });
    return { id, name };
  }

  async uploadFile(_uid: string, folderId: number, name: string, data: Uint8Array, mimeType = "application/octet-stream") {
    const upload_uuid = "upload-" + this.nextUpload++;
    this.uploads.set(upload_uuid, { name, data: new Uint8Array(data), mimeType, folderId });
    return { upload_uuid, name, size: data.byteLength };
  }

  async listFiles(_uid: string, folderId?: number) {
    const items = [];
    for (const [upload_uuid, file] of this.uploads) {
      if (folderId !== undefined && file.folderId !== folderId) continue;
      items.push({ upload_uuid, name: file.name, size: file.data.byteLength, mime_type: file.mimeType, folder_id: file.folderId, createdAt: 0 });
    }
    return items;
  }

  async downloadFile(_uid: string, uploadUuid: string) {
    if (this.failDownloadStatus !== undefined) throw new AppCloudError("下载失败", this.failDownloadStatus);
    const file = this.uploads.get(uploadUuid);
    if (!file) throw new AppCloudError("文件不存在", 404);
    return { contentType: file.mimeType, data: file.data };
  }

  async deleteFile(): Promise<void> {}
}

class FakeLiteratureClient implements LiteratureClient {
  async search(_query: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
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
  await app.register(multipart);
  registerAcademicRoutes(app, { academic, manuscriptDocx });
  return { app, store, cloud, manuscriptDocx };
}

/** Builds a multipart/form-data body by hand (no extra test dependency needed). */
function multipartBody(
  fileName: string | undefined,
  bytes: Uint8Array,
  fields: Record<string, string> = {},
) {
  const boundary = "----mindbase" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n",
      ),
    );
  }
  if (fileName !== undefined) {
    chunks.push(
      Buffer.from(
        "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: " + DOCX_MIME + "\r\n\r\n",
      ),
    );
    chunks.push(Buffer.from(bytes));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return {
    payload: Buffer.concat(chunks),
    headers: {
      "content-type": "multipart/form-data; boundary=" + boundary,
      "x-uid": "1",
    },
  };
}

/** Creates a project through the REST surface and returns its id. */
async function createProject(app: ReturnType<typeof Fastify>) {
  const created = await app.inject({
    method: "POST",
    url: "/academic/projects",
    headers: { "x-uid": "1", "content-type": "application/json" },
    payload: { title: "联邦学习隐私预算" },
  });
  expect(created.statusCode).toBe(200);
  return created.json().project.id as string;
}

describe("docx generation", () => {
  it("authors a complete package with title, sections and the four styles", async () => {
    const buffer = await buildDocxBuffer({
      title: "论文标题",
      sections: [
        { title: "摘要", content: "第一段\n第二段" },
        { title: "方法", content: "方法正文" },
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
      ]),
    );
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("论文标题");
    expect(documentXml).toContain("摘要");
    expect(documentXml).toContain("方法正文");
    expect(documentXml).toContain("第一段");
    expect(documentXml).toContain(pStyle("Title"));
    expect(documentXml).toContain(pStyle("Heading1"));
    expect(documentXml).toContain(preserveRun);

    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    expect(stylesXml).toContain("w:styleId=\"Title\"");
    expect(stylesXml).toContain("w:styleId=\"Heading1\"");
    expect(stylesXml).toContain("w:styleId=\"Heading2\"");
    expect(stylesXml).toContain("w:styleId=\"Normal\"");
    expect(stylesXml).toContain("w:name w:val=\"heading 1\"");
  });

  it("escapes XML metacharacters instead of emitting broken markup", async () => {
    const buffer = await buildDocxBuffer({
      title: "A & B <C>",
      sections: [{ title: "x & y", content: "1 < 2 > 0" }],
    });
    const documentXml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")!.async("string");
    expect(documentXml).toContain("A &amp; B &lt;C&gt;");
    expect(documentXml).toContain("1 &lt; 2 &gt; 0");
    expect(documentXml).not.toContain("<C>");
  });

  it("reuses the template package: styles.xml untouched and page setup preserved", async () => {
    const templateZip = await JSZip.loadAsync(
      await buildDocxBuffer({ title: "旧标题", sections: [{ title: "旧章节", content: "旧正文" }] }),
    );
    // Rename the heading style id and change the page margins, so both the
    // name -> styleId resolution and the sectPr carry-over are observable.
    const stylesXml = (await templateZip.file("word/styles.xml")!.async("string")).replace(
      "w:styleId=\"Heading1\"",
      "w:styleId=\"CustomHeading\" ",
    );
    templateZip.file("word/styles.xml", stylesXml);
    const templateDocument = (await templateZip.file("word/document.xml")!.async("string")).replace(
      "w:left=\"1800\"",
      "w:left=\"1234\"",
    );
    templateZip.file("word/document.xml", templateDocument);
    const template = await templateZip.generateAsync({ type: "nodebuffer" });

    const rebuilt = await buildDocxBuffer({
      title: "新标题",
      sections: [{ title: "新章节", content: "新正文" }],
      template,
    });
    const zip = await JSZip.loadAsync(rebuilt);
    expect(await zip.file("word/styles.xml")!.async("string")).toBe(stylesXml);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain(pStyle("CustomHeading"));
    expect(documentXml).toContain("w:left=\"1234\"");
    expect(documentXml).toContain("新标题");
    expect(documentXml).toContain("新章节");
    expect(documentXml).not.toContain("旧章节");
    expect(documentXml).not.toContain("旧正文");
  });
});

describe("docx parsing", () => {
  it("round-trips title, section titles and multi-line content", async () => {
    const buffer = await buildDocxBuffer({
      title: "Round Trip 论文",
      sections: [
        { title: "摘要", content: "第一段\n第二段" },
        { title: "实验", content: "实验正文" },
      ],
    });
    const parsed = await parseDocxSections(buffer);
    expect(parsed.title).toBe("Round Trip 论文");
    expect(parsed.sections.map((section) => section.title)).toEqual(["摘要", "实验"]);
    expect(parsed.sections[0].content).toBe("第一段\n第二段");
    expect(parsed.sections[1].content).toBe("实验正文");
  });

  it("collapses a heading-less document into one body section", async () => {
    const source = await buildDocxBuffer({
      title: "无标题文档",
      sections: [{ title: "第一章", content: "正文一" }],
    });
    const zip = await JSZip.loadAsync(source);
    const documentXml = (await zip.file("word/document.xml")!.async("string")).replace(
      /<w:pStyle w:val="[^"]+"\/>/g,
      "",
    );
    zip.file("word/document.xml", documentXml);
    const parsed = await parseDocxSections(await zip.generateAsync({ type: "nodebuffer" }));
    expect(parsed.title).toBeUndefined();
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].title).toBe("正文");
    expect(parsed.sections[0].content).toContain("无标题文档");
    expect(parsed.sections[0].content).toContain("第一章");
    expect(parsed.sections[0].content).toContain("正文一");
  });
});

describe("Word routes", () => {
  it("rejects an import without a file (400) and a non-docx file (422)", async () => {
    const { app } = await buildApp();
    const projectId = await createProject(app);

    const missing = multipartBody(undefined, new Uint8Array(), { title: "无文件" });
    const noFile = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import",
      headers: missing.headers,
      payload: missing.payload,
    });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().detail).toContain("file");

    const wrongType = multipartBody("note.txt", Buffer.from("plain text"));
    const notDocx = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import",
      headers: wrongType.headers,
      payload: wrongType.payload,
    });
    expect(notDocx.statusCode).toBe(422);
    expect(notDocx.json().detail).toContain(".docx");
    await app.close();
  });

  it("imports an existing Word manuscript (document + source recorded)", async () => {
    const { app, store, cloud } = await buildApp();
    const projectId = await createProject(app);

    const docx = await buildDocxBuffer({
      title: "已有 Word 稿",
      sections: [
        { title: "引言", content: "引言正文" },
        { title: "方法", content: "方法正文" },
      ],
    });
    const body = multipartBody("my-manuscript.docx", docx, { kind: "revision" });
    const imported = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import",
      headers: body.headers,
      payload: body.payload,
    });
    expect(imported.statusCode).toBe(200);
    const payload = imported.json();
    expect(payload.document.title).toBe("已有 Word 稿");
    expect(payload.document.kind).toBe("revision");
    expect(payload.document.sections.map((section: { title: string }) => section.title)).toEqual(["引言", "方法"]);
    expect(payload.source.fileName).toBe("my-manuscript.docx");
    expect(payload.source.uploadUuid).toBeTruthy();
    expect(typeof payload.source.folderId).toBe("number");

    const stored = await store.getDocument("1", payload.document.id);
    expect(stored?.source?.uploadUuid).toBe(payload.source.uploadUuid);
    expect(cloud.uploads.get(payload.source.uploadUuid)?.name).toBe("my-manuscript.docx");

    // Export reuses the uploaded original as the template: the package styles
    // come from the user file, the body is the (possibly edited) document.
    const download = await app.inject({
      method: "GET",
      url: "/academic/documents/" + payload.document.id + "/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(download.statusCode).toBe(200);
    const exportedZip = await JSZip.loadAsync(download.rawPayload);
    const originalZip = await JSZip.loadAsync(docx);
    expect(await exportedZip.file("word/styles.xml")!.async("string")).toBe(
      await originalZip.file("word/styles.xml")!.async("string"),
    );
    const exportedDocument = await exportedZip.file("word/document.xml")!.async("string");
    expect(exportedDocument).toContain("已有 Word 稿");
    expect(exportedDocument).toContain("引言");

    // The list payload carries the source so the writing tab can show "来自: ...".
    const list = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/documents",
      headers: { "x-uid": "1" },
    });
    const summary = list.json().documents.find((row: { id: string }) => row.id === payload.document.id);
    expect(summary.source.fileName).toBe("my-manuscript.docx");
    await app.close();
  });

  it("downloads the document as a .docx binary and 404s on unknown ids", async () => {
    const { app } = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: { kind: "draft", title: "下载稿" },
    });
    expect(created.statusCode).toBe(200);
    const documentId = created.json().document.id as string;

    const download = await app.inject({
      method: "GET",
      url: "/academic/documents/" + documentId + "/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain(DOCX_MIME);
    expect(String(download.headers["content-disposition"])).toContain("filename*=");
    expect(download.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const missing = await app.inject({
      method: "GET",
      url: "/academic/documents/does-not-exist/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("saves the generated Word back to the cloud drive and records lastExport", async () => {
    const { app, store, cloud } = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: { kind: "draft", title: "回存稿" },
    });
    const documentId = created.json().document.id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(saved.statusCode).toBe(200);
    const payload = saved.json();
    expect(payload.uploadUuid).toBeTruthy();
    expect(payload.fileName).toMatch(/^回存稿_\d{12}\.docx$/);
    expect(typeof payload.folderId).toBe("number");
    expect(typeof payload.createdAt).toBe("number");
    expect(cloud.uploads.get(payload.uploadUuid)?.mimeType).toBe(DOCX_MIME);

    const stored = await store.getDocument("1", documentId);
    expect(stored?.lastExport?.uploadUuid).toBe(payload.uploadUuid);

    // The list payload carries lastExport so the writing tab can show "最近回存".
    const list = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/documents",
      headers: { "x-uid": "1" },
    });
    const summary = list.json().documents.find((row: { id: string }) => row.id === documentId);
    expect(summary.lastExport.uploadUuid).toBe(payload.uploadUuid);

    const missing = await app.inject({
      method: "POST",
      url: "/academic/documents/does-not-exist/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("answers 503 when the cloud drive is not configured", async () => {
    const { app } = await buildApp({ cloudConfigured: false });
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: { kind: "draft", title: "无云盘稿" },
    });
    const documentId = created.json().document.id as string;

    const saved = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/export/docx",
      headers: { "x-uid": "1" },
    });
    expect(saved.statusCode).toBe(503);
    expect(saved.json().detail).toContain("云盘服务暂不可用");

    const docx = await buildDocxBuffer({ title: "稿", sections: [{ title: "正文", content: "x" }] });
    const body = multipartBody("upload.docx", docx);
    const imported = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents/import",
      headers: body.headers,
      payload: body.payload,
    });
    expect(imported.statusCode).toBe(503);
    expect(imported.json().detail).toContain("云盘服务暂不可用");
    await app.close();
  });
});

/** Extracts the tool text payload (tools may return a string or { content }). */
function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

describe("academic_manuscript export_docx", () => {
  it("delegates the Word export to the injected service and reports the cloud file", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "工具项目" });
    const document = await store.createDocument("1", project.id, {
      kind: "draft",
      title: "工具稿",
      sections: [{ title: "摘要", content: "正文" }],
    });
    const calls: Array<{ uid: string; documentId: string }> = [];
    const tool = createAcademicManuscriptTool({
      documents: store,
      projects: store,
      events: store,
      docx: {
        exportDocxToCloud: async (uid: string, documentId: string) => {
          calls.push({ uid, documentId });
          return { uploadUuid: "cloud-1", fileName: "工具稿_202611121200.docx", folderId: 5, createdAt: 1 };
        },
      },
    });
    const ctx: ToolRunContext = { uid: "1", scope: {}, collector: new ResultCollector() };
    const output = contentOf(
      await tool.execute({ action: "export_docx", projectId: project.id, documentId: document.id }, ctx),
    );
    expect(output).toContain("工具稿_202611121200.docx");
    expect(output).toContain("cloud-1");
    expect(calls).toEqual([{ uid: "1", documentId: document.id }]);
    const artifact = ctx.collector.artifacts.filter((item) => item.kind === "academic_manuscript").pop();
    expect((artifact?.data as { action?: string }).action).toBe("export_docx");
  });

  it("degrades to guidance text when the Word service is not injected", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("1", { title: "工具项目" });
    const document = await store.createDocument("1", project.id, { kind: "draft", title: "工具稿" });
    const tool = createAcademicManuscriptTool({ documents: store, projects: store, events: store });
    const ctx: ToolRunContext = { uid: "1", scope: {}, collector: new ResultCollector() };
    const output = contentOf(
      await tool.execute({ action: "export_docx", projectId: project.id, documentId: document.id }, ctx),
    );
    expect(output).toContain("未启用");
  });
});
