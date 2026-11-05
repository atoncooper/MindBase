import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { AcademicService } from "../src/services/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/auth/literature-client.js";

/**
 * Route-level tests for /academic/* (plan/1.0.17 Phase 2): uid comes from the
 * request context (gateway X-Uid), domain errors map to { status, detail }, and
 * bodies round-trip camelCase JSON. Uses a bare Fastify instance + the real
 * service over memory repositories (no network/Mongo).
 */

class FakeLiteratureClient implements LiteratureClient {
  hits: LiteratureHit[] = [];
  dois = new Map<string, LiteratureHit>();
  async search(_q: string, options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return this.hits.slice(0, options?.limit ?? 5).map((hit) => ({ ...hit, authors: [...hit.authors] }));
  }
  async lookupDoi(doi: string): Promise<LiteratureHit | null> {
    const hit = this.dois.get(doi);
    return hit ? { ...hit, authors: [...hit.authors] } : null;
  }
}

function buildApp() {
  const store = new MemoryAcademicStore();
  const client = new FakeLiteratureClient();
  const service = new AcademicService({ projects: store, literature: store, documents: store, events: store, client });
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerAcademicRoutes(app, { academic: service });
  return { app, store, client };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });

describe("academic routes", () => {
  it("requires the gateway uid", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/academic/projects" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates, lists and reads a project", async () => {
    const { app } = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/academic/projects",
      headers: asUid("123"),
      payload: { title: "联邦学习隐私预算", paperType: "journal", field: "机器学习", deadline: "2026-12-31" },
    });
    expect(created.statusCode).toBe(200);
    const detail = created.json();
    expect(detail.project.title).toBe("联邦学习隐私预算");
    expect(detail.project.deadline).toBe("2026-12-31");
    const projectId = detail.project.id;

    const list = await app.inject({ method: "GET", url: "/academic/projects", headers: asUid("123") });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toHaveLength(1);

    const read = await app.inject({ method: "GET", url: "/academic/projects/" + projectId, headers: asUid("123") });
    expect(read.statusCode).toBe(200);
    expect(read.json().project.id).toBe(projectId);

    const foreign = await app.inject({ method: "GET", url: "/academic/projects/" + projectId, headers: asUid("999") });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });

  it("patches stages/plans/advice and rejects invalid input with detail", async () => {
    const { app } = buildApp();
    const detail = (
      await app.inject({ method: "POST", url: "/academic/projects", headers: asUid("1"), payload: { title: "A" } })
    ).json();
    const patched = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + detail.project.id,
      headers: asUid("1"),
      payload: { stage: "design", plans: { design: [{ id: "t1", title: "设计实验", done: false }] } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().project.stage).toBe("design");
    expect(patched.json().plans.design[0].title).toBe("设计实验");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + detail.project.id,
      headers: asUid("1"),
      payload: { stage: "bogus" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().detail).toContain("stage");
    await app.close();
  });

  it("handles the literature workflow (add, list, verify, export, delete)", async () => {
    const { app, client } = buildApp();
    const detail = (
      await app.inject({ method: "POST", url: "/academic/projects", headers: asUid("1"), payload: { title: "A" } })
    ).json();
    const projectId = detail.project.id;

    const added = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/literature",
      headers: asUid("1"),
      payload: { title: "Attention Is All You Need", authors: ["Ashish Vaswani"], year: 2017, doi: "10.1/attn" },
    });
    expect(added.statusCode).toBe(200);
    const entry = added.json().entry;
    expect(entry.citeKey).toBe("vaswani2017");
    expect(entry.verified).toBe(false);

    const list = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/literature?limit=10&offset=0",
      headers: asUid("1"),
    });
    expect(list.json().total).toBe(1);
    expect(list.json().entries).toHaveLength(1);

    client.dois.set("10.1/attn", { source: "crossref", title: "Attention Is All You Need", authors: ["A"] });
    const verify = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/literature/" + encodeURIComponent(entry.citeKey) + "/verify",
      headers: { "x-uid": "1" },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(true);

    const exported = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/literature/export",
      headers: asUid("1"),
    });
    expect(exported.json().bibtex).toContain("@article{vaswani2017");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/academic/projects/" + projectId + "/literature/" + encodeURIComponent(entry.citeKey),
      headers: { "x-uid": "1" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    await app.close();
  });

  it("searches literature through the injected client", async () => {
    const { app, client } = buildApp();
    client.hits = [{ source: "crossref", title: "Hit", authors: ["A"], year: 2020, doi: "10.1/h" }];
    const res = await app.inject({ method: "GET", url: "/academic/literature/search?q=graph", headers: asUid("1") });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toHaveLength(1);
    const bad = await app.inject({ method: "GET", url: "/academic/literature/search", headers: asUid("1") });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("manages documents, sections and exports", async () => {
    const { app } = buildApp();
    const detail = (
      await app.inject({ method: "POST", url: "/academic/projects", headers: asUid("1"), payload: { title: "A" } })
    ).json();
    const projectId = detail.project.id;
    const created = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/documents",
      headers: asUid("1"),
      payload: { kind: "draft", title: "初稿" },
    });
    expect(created.statusCode).toBe(200);
    const document = created.json().document;
    expect(document.sections).toHaveLength(6);

    const saved = await app.inject({
      method: "POST",
      url: "/academic/documents/" + document.id + "/sections",
      headers: asUid("1"),
      payload: { key: "method", title: "方法", content: "方法正文" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().document.sections.find((s: { key: string }) => s.key === "method").content).toBe("方法正文");

    const md = await app.inject({
      method: "GET",
      url: "/academic/documents/" + document.id + "/export?format=markdown",
      headers: asUid("1"),
    });
    expect(md.json().text).toContain("# 初稿");
    expect(md.json().text).toContain("方法正文");

    const list = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/documents",
      headers: asUid("1"),
    });
    expect(list.json().documents[0].wordCount).toBeGreaterThan(0);

    const events = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/events?limit=5",
      headers: asUid("1"),
    });
    expect(events.json().events.length).toBeGreaterThan(0);
    await app.close();
  });
});
