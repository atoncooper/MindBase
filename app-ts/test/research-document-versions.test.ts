import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchDocumentRevisionRepository } from "../src/repository/memory/research-document-revisions.js";
import {
  ACADEMIC_DOCUMENT_KINDS,
  ACADEMIC_DOCUMENT_KIND_LABELS,
  type AcademicDocument,
  type AcademicProject,
} from "../src/repository/academic.js";
import { defaultSectionsForKind } from "../src/services/research/manuscript-templates.js";
import { DocumentVersionService } from "../src/services/research/document-versions.js";
import {
  REVIEW_RESPONSE_MAX_ITEMS,
  ReviewResponseService,
  buildResponseLetter,
} from "../src/services/research/review-response.js";
import { AcademicError, AcademicService } from "../src/services/research/academic.js";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";

/**
 * Document version history (snapshot/list/diff/restore), review-response letters
 * and their manuscript-tool / REST surfaces. Everything runs offline over the
 * memory repositories.
 */

class FakeLiteratureClient implements LiteratureClient {
  async search(_query: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

function makeCtx(uid?: string): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

async function expectAcademicError(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AcademicError);
    expect((err as AcademicError).status).toBe(status);
    return;
  }
  throw new Error("expected an AcademicError(" + status + ")");
}

async function setup() {
  const store = new MemoryAcademicStore();
  const revisions = new MemoryResearchDocumentRevisionRepository();
  const versions = new DocumentVersionService({ revisions, documents: store });
  const reviewResponse = new ReviewResponseService({ documents: store, events: store });
  const tool = createAcademicManuscriptTool({ documents: store, projects: store, events: store, versions });
  const project = await store.create("u1", { title: "图学习研究" });
  const doc = await store.createDocument("u1", project.id, { kind: "draft", title: "投稿初稿" });
  return { store, revisions, versions, reviewResponse, tool, project, doc };
}

async function reload(store: MemoryAcademicStore, documentId: string): Promise<AcademicDocument> {
  const document = await store.getDocument("u1", documentId);
  if (!document) throw new Error("document missing");
  return document;
}

// ---------------------------------------------------------------------------
// Service: snapshot / list
// ---------------------------------------------------------------------------

describe("DocumentVersionService: snapshot + list", () => {
  it("creates monotonic versions and lists them oldest first", async () => {
    const { store, revisions, versions, project, doc } = await setup();
    const v1 = await versions.snapshot("u1", project, doc, "初稿完成");
    expect(v1.version).toBe(1);
    expect(v1.documentId).toBe(doc.id);
    expect(v1.projectId).toBe(project.id);
    expect(v1.reason).toBe("初稿完成");
    expect(v1.sections).toHaveLength(doc.sections.length);

    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "改进后的方法" });
    const v2 = await versions.snapshot("u1", project.id, await reload(store, doc.id));
    expect(v2.version).toBe(2);
    expect(v2.reason).toBeUndefined();
    expect(v2.sections.find((section) => section.key === "method")?.content).toBe("改进后的方法");

    const list = await versions.list("u1", project.id, doc.id);
    expect(list.map((revision) => revision.version)).toEqual([1, 2]);
    expect((await revisions.latest("u1", doc.id))?.version).toBe(2);
    expect((await revisions.get("u1", v1.id))?.version).toBe(1);
  });

  it("scopes snapshots by uid", async () => {
    const { revisions, versions, project, doc } = await setup();
    const v1 = await versions.snapshot("u1", project, doc);
    expect(await revisions.listByDocument("u2", project.id, doc.id)).toEqual([]);
    expect(await revisions.get("u2", v1.id)).toBeNull();
    expect(await revisions.latest("u2", doc.id)).toBeNull();
    await expectAcademicError(versions.snapshot("u2", project.id, doc), 404);
    await expectAcademicError(versions.list("u2", project.id, doc.id), 404);
  });
});

// ---------------------------------------------------------------------------
// Service: diff
// ---------------------------------------------------------------------------

describe("DocumentVersionService: diff", () => {
  it("aligns sections by key and counts added/removed lines", async () => {
    const { store, versions, project, doc } = await setup();
    await store.upsertSection("u1", doc.id, {
      key: "method",
      title: "方法",
      content: "第一行\n第二行\n第三行",
    });
    await versions.snapshot("u1", project.id, await reload(store, doc.id));
    await store.upsertSection("u1", doc.id, {
      key: "method",
      title: "方法",
      content: "第一行\n改写行\n第三行",
    });
    await store.upsertSection("u1", doc.id, {
      key: "results",
      title: "结果",
      content: "结果甲\n结果乙",
      order: 9,
    });
    await versions.snapshot("u1", project.id, await reload(store, doc.id));

    const diff = await versions.diff("u1", project.id, doc.id, 1, 2);
    expect(diff.from.version).toBe(1);
    expect(diff.to).toMatchObject({ version: 2, current: false });

    const method = diff.sections.find((section) => section.key === "method");
    expect(method?.status).toBe("changed");
    expect(method?.addedLines).toBe(1);
    expect(method?.removedLines).toBe(1);
    expect(method?.added).toEqual(["改写行"]);
    expect(method?.removed).toEqual(["第二行"]);

    const results = diff.sections.find((section) => section.key === "results");
    expect(results?.status).toBe("added");
    expect(results?.addedLines).toBe(2);

    expect(diff.addedLines).toBe(3);
    expect(diff.removedLines).toBe(1);
    expect(diff.summary).toContain("v1 → v2");
    expect(diff.summary).toContain("新增 3 行");
    expect(diff.summary).toContain("删除 1 行");
  });

  it("compares a historical version with the current document by default", async () => {
    const { store, versions, project, doc } = await setup();
    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "第一行" });
    await versions.snapshot("u1", project.id, await reload(store, doc.id));
    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "第一行\n第二行" });

    const diff = await versions.diff("u1", project.id, doc.id, 1);
    expect(diff.to.current).toBe(true);
    expect(diff.to.version).toBeUndefined();
    expect(diff.sections.find((section) => section.key === "method")?.addedLines).toBe(1);
    expect(diff.summary).toContain("当前文档");
  });

  it("rejects missing versions and foreign documents", async () => {
    const { versions, project, doc } = await setup();
    await versions.snapshot("u1", project.id, doc);
    await expectAcademicError(versions.diff("u1", project.id, doc.id, 9), 404);
    await expectAcademicError(versions.diff("u1", project.id, doc.id, 1, 9), 404);
    await expectAcademicError(versions.diff("u2", project.id, doc.id, 1), 404);
    await expectAcademicError(versions.diff("u1", "p-other", doc.id, 1), 404);
  });
});

// ---------------------------------------------------------------------------
// Service: restore
// ---------------------------------------------------------------------------

describe("DocumentVersionService: restore", () => {
  it("snapshots the current state, then restores the old sections", async () => {
    const { store, versions, project, doc } = await setup();
    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "旧正文" });
    await versions.snapshot("u1", project.id, await reload(store, doc.id));

    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "新正文\n新增行" });
    await store.upsertSection("u1", doc.id, { key: "appendix", title: "附录", content: "附录内容", order: 20 });

    const restored = await versions.restore("u1", project.id, doc.id, 1);
    expect(restored.restoredFrom.version).toBe(1);
    expect(restored.snapshot.version).toBe(2);
    expect(restored.snapshot.sections.find((section) => section.key === "method")?.content).toBe(
      "新正文\n新增行",
    );
    expect(restored.document.sections.find((section) => section.key === "method")?.content).toBe("旧正文");
    expect(restored.document.sections.some((section) => section.key === "appendix")).toBe(false);

    const list = await versions.list("u1", project.id, doc.id);
    expect(list.map((revision) => revision.version)).toEqual([1, 2]);
    await expectAcademicError(versions.restore("u1", project.id, doc.id, 9), 404);
    await expectAcademicError(versions.restore("u2", project.id, doc.id, 1), 404);
  });
});

// ---------------------------------------------------------------------------
// Review response letter
// ---------------------------------------------------------------------------

describe("buildResponseLetter", () => {
  it("builds the three fixed sections from the provided items", () => {
    const letter = buildResponseLetter("图学习论文", [
      { comment: "缺少消融实验。", response: "已补充消融实验，见 4.3 节。", change: "在「实验」章节新增 4.3 节。" },
      { comment: "英文表述需润色。", response: "已全文润色。" },
    ]);
    expect(letter.title).toBe("审稿回复信：图学习论文");
    expect(letter.sections.map((section) => section.title)).toEqual(["审稿意见汇总", "逐条回复", "修改清单"]);
    expect(letter.sections.map((section) => section.key)).toEqual(["comments", "responses", "changes"]);
    expect(letter.sections[0]?.content).toContain("1. 缺少消融实验。");
    expect(letter.sections[1]?.content).toContain("已全文润色。");
    expect(letter.sections[2]?.content).toContain("4.3 节");
    expect(letter.sections[2]?.content).not.toContain("润色");
    // 全部条目都没有修改说明时不编造内容。
    const noChange = buildResponseLetter("另一篇", [{ comment: "补充实验。", response: "已补充。" }]);
    expect(noChange.sections[2]?.content).toContain("未提供具体修改说明");
  });

  it("rejects empty and oversized item lists", () => {
    expect(() => buildResponseLetter("x", [])).toThrow(AcademicError);
    const tooMany = Array.from({ length: REVIEW_RESPONSE_MAX_ITEMS + 1 }, (_value, index) => ({
      comment: "意见 " + index,
      response: "回复 " + index,
    }));
    expect(() => buildResponseLetter("x", tooMany)).toThrow(AcademicError);
    expect(() => buildResponseLetter("x", [{ comment: " ", response: "回复" }])).toThrow(AcademicError);
  });
});

describe("ReviewResponseService", () => {
  it("creates a revision document and records the event", async () => {
    const { store, project, reviewResponse } = await setup();
    const created = await reviewResponse.create("u1", project.id, {
      documentTitle: "图学习论文",
      items: [
        { comment: "缺少消融实验。", response: "已补充。", change: "新增 4.3 节。" },
        { comment: "英文需润色。", response: "已润色。" },
      ],
      actor: "user",
    });
    expect(created.document.kind).toBe("revision");
    expect(created.document.title).toContain("审稿回复信");
    expect(created.document.sections.map((section) => section.title)).toEqual([
      "审稿意见汇总",
      "逐条回复",
      "修改清单",
    ]);
    const stored = await store.getDocument("u1", created.document.id);
    expect(stored?.sections[0]?.content).toContain("缺少消融实验");
    const events = await store.listEvents("u1", project.id);
    expect(events.some((event) => event.type === "manuscript.review_response_created")).toBe(true);
  });

  it("registers the response_letter kind with its default outline", () => {
    expect(ACADEMIC_DOCUMENT_KINDS).toContain("response_letter");
    expect(ACADEMIC_DOCUMENT_KIND_LABELS.response_letter).toBe("审稿回复信");
    expect(defaultSectionsForKind("response_letter").map((section) => section.title)).toEqual([
      "审稿意见汇总",
      "逐条回复",
      "修改清单",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Manuscript tool actions
// ---------------------------------------------------------------------------

describe("academic_manuscript: version actions", () => {
  it("lists versions, diffs and restores through the tool", async () => {
    const { store, versions, tool, project, doc } = await setup();
    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "旧正文" });
    await versions.snapshot("u1", project.id, await reload(store, doc.id), "初稿");
    await store.upsertSection("u1", doc.id, { key: "method", title: "方法", content: "新正文" });
    await versions.snapshot("u1", project.id, await reload(store, doc.id));

    const ctx = makeCtx("u1");
    const versionsText = contentOf(
      await tool.execute({ action: "versions", projectId: project.id, documentId: doc.id }, ctx),
    );
    expect(versionsText).toContain("v1");
    expect(versionsText).toContain("v2");
    expect(versionsText).toContain("初稿");
    expect(
      ctx.collector.artifacts.some(
        (artifact) => artifact.kind === "academic_manuscript" && (artifact.data as { action?: string }).action === "versions",
      ),
    ).toBe(true);

    const diffText = contentOf(
      await tool.execute(
        { action: "diff", projectId: project.id, documentId: doc.id, version: 1, toVersion: 2 },
        ctx,
      ),
    );
    expect(diffText).toContain("v1 → v2");
    expect(diffText).toContain("修改 1 节");

    const restoreText = contentOf(
      await tool.execute({ action: "restore", projectId: project.id, documentId: doc.id, version: 1 }, ctx),
    );
    expect(restoreText).toContain("已把文档");
    expect(restoreText).toContain("回滚到 v1");
    expect((await reload(store, doc.id)).sections.find((section) => section.key === "method")?.content).toBe(
      "旧正文",
    );
    const events = await store.listEvents("u1", project.id);
    expect(events.some((event) => event.type === "manuscript.version_restored")).toBe(true);
  });

  it("creates a review-response document through the tool", async () => {
    const { store, tool, project } = await setup();
    const ctx = makeCtx("u1");
    const text = contentOf(
      await tool.execute(
        {
          action: "review_response",
          projectId: project.id,
          title: "图学习论文",
          items: [
            { comment: "需要补充相关工作。", response: "已补充 2.1 节。", change: "相关工作新增 2.1 节。" },
          ],
        },
        ctx,
      ),
    );
    expect(text).toContain("已创建审稿回复信文档");
    const documentId = /document_id: ([\w-]+)/.exec(text)?.[1] ?? "";
    expect(documentId).not.toBe("");
    const document = await store.getDocument("u1", documentId);
    expect(document?.kind).toBe("revision");
    expect(document?.sections.map((section) => section.title)).toEqual([
      "审稿意见汇总",
      "逐条回复",
      "修改清单",
    ]);
    expect(
      ctx.collector.artifacts.some(
        (artifact) =>
          artifact.kind === "academic_manuscript" &&
          (artifact.data as { action?: string }).action === "review_response",
      ),
    ).toBe(true);
  });

  it("answers with guidance when the version service is not assembled", async () => {
    const store = new MemoryAcademicStore();
    const tool = createAcademicManuscriptTool({ documents: store, projects: store, events: store });
    const project = await store.create("u1", { title: "项目" });
    const doc = await store.createDocument("u1", project.id, { kind: "draft", title: "初稿" });
    const ctx = makeCtx("u1");
    for (const action of ["versions", "diff", "restore"] as const) {
      const text = contentOf(
        await tool.execute({ action, projectId: project.id, documentId: doc.id, version: 1 }, ctx),
      );
      expect(text).toContain("版本服务未启用");
    }
  });
});

// ---------------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------------

function buildRouteApp() {
  const store = new MemoryAcademicStore();
  const revisions = new MemoryResearchDocumentRevisionRepository();
  const versions = new DocumentVersionService({ revisions, documents: store });
  const reviewResponse = new ReviewResponseService({ documents: store, events: store });
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
  registerAcademicRoutes(app, { academic, versions, reviewResponse });
  return { app, store, academic, versions };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });
/** 无请求体的 POST 不能声明 JSON content-type（Fastify 400）。 */
const uidOnly = (uid: string) => ({ "x-uid": uid });

async function seedRouteDocument() {
  const built = buildRouteApp();
  const detail = await built.academic.createProject("1", { title: "路由项目" });
  const projectId = detail.project.id;
  const created = await built.academic.createDocument("1", projectId, { kind: "draft", title: "初稿" });
  const documentId = created.document.id;
  const { document } = await built.academic.getDocument("1", documentId);
  await built.versions.snapshot("1", projectId, document as AcademicDocument, "v1");
  return { ...built, projectId, documentId };
}

describe("academic document version routes", () => {
  it("requires the gateway uid", async () => {
    const { app } = buildRouteApp();
    const res = await app.inject({ method: "GET", url: "/academic/documents/d1/versions" });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain("X-Uid");
    await app.close();
  });

  it("lists versions, diffs and restores", async () => {
    const { app, documentId } = await seedRouteDocument();

    const list = await app.inject({
      method: "GET",
      url: "/academic/documents/" + documentId + "/versions",
      headers: asUid("1"),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().versions).toHaveLength(1);
    expect(list.json().versions[0].version).toBe(1);

    const diff = await app.inject({
      method: "GET",
      url: "/academic/documents/" + documentId + "/versions/1/diff",
      headers: asUid("1"),
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().from.version).toBe(1);
    expect(diff.json().to.current).toBe(true);

    const restored = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/versions/1/restore",
      headers: uidOnly("1"),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restoredFrom.version).toBe(1);
    expect(restored.json().snapshot.version).toBe(2);

    const foreign = await app.inject({
      method: "GET",
      url: "/academic/documents/" + documentId + "/versions",
      headers: asUid("999"),
    });
    expect(foreign.statusCode).toBe(404);

    const badVersion = await app.inject({
      method: "GET",
      url: "/academic/documents/" + documentId + "/versions/abc/diff",
      headers: asUid("1"),
    });
    expect(badVersion.statusCode).toBe(422);

    const missingVersion = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/versions/9/restore",
      headers: uidOnly("1"),
    });
    expect(missingVersion.statusCode).toBe(404);
    await app.close();
  });

  it("creates a review-response document from items", async () => {
    const { app, documentId, store } = await seedRouteDocument();
    const res = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/review-response",
      headers: asUid("1"),
      payload: {
        items: [
          { comment: "补充消融实验。", response: "已补充。", change: "新增 4.3 节。" },
          { comment: "润色英文。", response: "已润色。" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const document = res.json().document as AcademicDocument;
    expect(document.kind).toBe("revision");
    expect(document.sections).toHaveLength(3);
    expect((await store.getDocument("1", document.id))?.sections[0]?.content).toContain("补充消融实验");

    const invalid = await app.inject({
      method: "POST",
      url: "/academic/documents/" + documentId + "/review-response",
      headers: asUid("1"),
      payload: { items: [] },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().detail).toContain("items");

    const missing = await app.inject({
      method: "POST",
      url: "/academic/documents/nope/review-response",
      headers: asUid("1"),
      payload: { items: [{ comment: "意见", response: "回复" }] },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
