import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ACADEMIC_STAGES,
  citeKeyFor,
  initialStageStates,
  literatureDedupeKey,
  normalizeDoi,
  slugKey,
  wordCount,
  type AcademicDocumentRepository,
  type AcademicEventRepository,
  type AcademicLiteratureRepository,
  type AcademicProjectRepository,
} from "../src/repository/academic.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";

/**
 * Academic repository contract tests (plan/1.0.17 Phase 1).
 *
 * Memory implementation runs the full suite offline. The Mongo adapter is
 * exercised when a local MongoDB (docker compose) is listening — same pattern as
 * mongo-memory-store.test.ts — and points at the dedicated test database so the
 * real mind_base_ts collections are never touched.
 */

// Mongo adapter is imported dynamically in beforeAll so these env vars are in
// place before config/index.ts is evaluated (ESM hoists static imports).
if (!process.env.MONGO__URI) process.env.MONGO__URI = "mongodb://127.0.0.1:27017";
if (!process.env.MONGO__DATABASE) process.env.MONGO__DATABASE = "mind_base_ts_test";

function freshUid(): string {
  return `u-${randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Contract helpers (the implementations must reuse these, not reinvent them)
// ---------------------------------------------------------------------------

describe("academic contract helpers", () => {
  it("initialStageStates: topic active, every other stage locked, same timestamp", () => {
    const states = initialStageStates(1_700_000_000_000);
    for (const stage of ACADEMIC_STAGES) {
      expect(states[stage].status).toBe(stage === "topic" ? "active" : "locked");
      expect(states[stage].updatedAt).toBe(1_700_000_000_000);
      expect(states[stage].note).toBeUndefined();
    }
    expect(Object.keys(states).sort()).toEqual([...ACADEMIC_STAGES].sort());
  });

  it("normalizeDoi strips the doi.org URL prefix and lowercases", () => {
    expect(normalizeDoi("https://doi.org/10.1/ABC")).toBe("10.1/abc");
    expect(normalizeDoi("http://dx.doi.org/10.2/X")).toBe("10.2/x");
    expect(normalizeDoi("  10.3/Y  ")).toBe("10.3/y");
    expect(normalizeDoi(undefined)).toBe("");
    expect(normalizeDoi("")).toBe("");
  });

  it("literatureDedupeKey prefers DOI, otherwise normalizes title + year", () => {
    expect(literatureDedupeKey({ title: "Any title", year: 2020, doi: "https://doi.org/10.1/A" })).toBe(
      "doi:10.1/a",
    );
    expect(literatureDedupeKey({ title: "  Deep   Learning ", year: 2020 })).toBe(
      "title:deep learning|year:2020",
    );
    expect(literatureDedupeKey({ title: "No Year" })).toBe("title:no year|year:");
  });

  it("citeKeyFor derives author+year and suffixes duplicates", () => {
    expect(citeKeyFor({ title: "t", authors: ["San Zhang"], year: 2024 })).toBe("zhang2024");
    expect(citeKeyFor({ title: "t", authors: ["San Zhang"], year: 2024 }, ["zhang2024"])).toBe(
      "zhang2024a",
    );
    expect(
      citeKeyFor({ title: "t", authors: ["San Zhang"], year: 2024 }, ["zhang2024", "zhang2024a"]),
    ).toBe("zhang2024b");
    expect(citeKeyFor({ title: "t", authors: ["张三"], year: 2024 })).toBe("anon2024");
    expect(citeKeyFor({ title: "t" })).toBe("anonnd");
  });

  it("slugKey keeps lowercase ascii words joined by dashes", () => {
    expect(slugKey("Method & Results!")).toBe("method-results");
    expect(slugKey("  Leading and trailing  ")).toBe("leading-and-trailing");
    expect(slugKey("引言")).toBe("");
  });

  it("wordCount counts CJK characters once and latin words once", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("Hello world")).toBe(2);
    expect(wordCount("你好世界")).toBe(4);
    expect(wordCount("Hello 世界")).toBe(3);
    expect(wordCount("RAG 检索 2024")).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

describe("MemoryAcademicStore · projects", () => {
  it("create gives stage defaults (topic active, others locked) and empty plans/advice", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "推荐系统综述" });

    expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(project.uid).toBe(uid);
    expect(project.title).toBe("推荐系统综述");
    expect(project.paperType).toBe("journal");
    expect(project.field).toBe("");
    expect(project.targetJournal).toBeUndefined();
    expect(project.deadline).toBeUndefined();
    expect(project.stage).toBe("topic");
    expect(project.stages).toEqual(initialStageStates(project.createdAt));
    expect(project.plans).toEqual({});
    expect(project.advice).toEqual({});
    expect(project.createdAt).toBeGreaterThan(0);
    expect(project.updatedAt).toBe(project.createdAt);
  });

  it("create keeps explicit paperType/field/targetJournal/deadline", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create(freshUid(), {
      title: "基金申请书",
      paperType: "fund",
      field: "知识图谱",
      targetJournal: "国家自然科学基金",
      deadline: "2026-03-01",
    });
    expect(project.paperType).toBe("fund");
    expect(project.field).toBe("知识图谱");
    expect(project.targetJournal).toBe("国家自然科学基金");
    expect(project.deadline).toBe("2026-03-01");
  });

  it("list returns only the uid's projects, most recently updated first", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.create(uid, { title: "第一个项目" });
    await sleep(5);
    const second = await store.create(uid, { title: "第二个项目" });
    const other = await store.create(freshUid(), { title: "别人的项目" });

    expect((await store.list(uid)).map((p) => p.id)).toEqual([second.id, first.id]);
    expect((await store.list(other.uid)).map((p) => p.id)).toEqual([other.id]);

    await sleep(5);
    await store.update(uid, first.id, { title: "第一个项目（已更新）" });
    expect((await store.list(uid)).map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it("get is scoped by uid and returns null for unknown ids", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "项目" });

    expect((await store.get(uid, project.id))?.title).toBe("项目");
    expect(await store.get(freshUid(), project.id)).toBeNull();
    expect(await store.get(uid, "missing-project")).toBeNull();
  });

  it("update shallow-merges plain fields, preserves createdAt and bumps updatedAt", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const created = await store.create(uid, { title: "旧标题", paperType: "journal", field: "旧领域" });
    await sleep(5);

    const updated = await store.update(uid, created.id, {
      title: "新标题",
      field: "新领域",
      stage: "design",
      deadline: "2027-01-01",
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("新标题");
    expect(updated!.field).toBe("新领域");
    expect(updated!.stage).toBe("design");
    expect(updated!.deadline).toBe("2027-01-01");
    expect(updated!.paperType).toBe("journal"); // untouched
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
    // stage focus changed, but the stage state machine itself was not touched
    expect(updated!.stages).toEqual(initialStageStates(created.createdAt));
  });

  it("update merges stages/plans/advice key by key and preserves omitted keys", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "阶段合并" });

    const topicPlan = [{ id: "t1", title: "读三篇综述", done: false }];
    const designPlan = [{ id: "t2", title: "写实验设计", done: true, note: "已评审" }];
    let updated = await store.update(uid, project.id, {
      plans: { topic: topicPlan },
      advice: { topic: "先做文献综述" },
    });
    expect(updated!.plans.topic).toEqual(topicPlan);
    expect(updated!.advice.topic).toBe("先做文献综述");

    updated = await store.update(uid, project.id, {
      stages: { design: { status: "submitted", updatedAt: 123, note: "等待用户确认" } },
      plans: { design: designPlan },
      advice: { writing: "先写方法再写引言" },
    });
    expect(updated!.stages.design).toEqual({
      status: "submitted",
      updatedAt: 123,
      note: "等待用户确认",
    });
    expect(updated!.stages.topic).toEqual(initialStageStates(project.createdAt).topic);
    expect(updated!.stages.experiment.status).toBe("locked");
    expect(updated!.plans.topic).toEqual(topicPlan); // preserved
    expect(updated!.plans.design).toEqual(designPlan);
    expect(updated!.advice.topic).toBe("先做文献综述"); // preserved
    expect(updated!.advice.writing).toBe("先写方法再写引言");

    // a provided key replaces that key's value (empty array clears the plan)
    updated = await store.update(uid, project.id, { plans: { topic: [] } });
    expect(updated!.plans.topic).toEqual([]);
    expect(updated!.plans.design).toEqual(designPlan);
  });

  it("update returns null for unknown or foreign projects and leaves them untouched", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "原始" });

    expect(await store.update(freshUid(), project.id, { title: "入侵" })).toBeNull();
    expect(await store.update(uid, "missing-project", { title: "x" })).toBeNull();
    expect((await store.get(uid, project.id))?.title).toBe("原始");
  });

  it("remove deletes only the uid's project and reports the second delete as false", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "待删除" });

    expect(await store.remove(freshUid(), project.id)).toBe(false);
    expect(await store.remove(uid, project.id)).toBe(true);
    expect(await store.get(uid, project.id)).toBeNull();
    expect(await store.remove(uid, project.id)).toBe(false);
    expect(await store.list(uid)).toEqual([]);
  });

  it("reads are deep copies: mutating a returned project cannot touch stored state", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "深拷贝" });
    await store.update(uid, project.id, { plans: { topic: [{ id: "t1", title: "任务", done: false }] } });

    const read = await store.get(uid, project.id);
    read!.title = "被篡改";
    read!.stages.topic.status = "frozen";
    read!.plans.topic![0].title = "被篡改的任务";

    const again = await store.get(uid, project.id);
    expect(again!.title).toBe("深拷贝");
    expect(again!.stages.topic.status).toBe("active");
    expect(again!.plans.topic![0].title).toBe("任务");
  });

  it("update stores a copy of the patch (later mutation of the input has no effect)", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "补丁复制" });
    const patch = { plans: { topic: [{ id: "t1", title: "原始任务", done: false }] } };
    await store.update(uid, project.id, patch);

    patch.plans.topic[0].title = "外部篡改";
    const read = await store.get(uid, project.id);
    expect(read!.plans.topic![0].title).toBe("原始任务");
  });

  it("update writes explicit clears (empty plan array, empty advice string) and keeps siblings", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const project = await store.create(uid, { title: "清空语义" });
    await store.update(uid, project.id, {
      plans: { topic: [{ id: "t1", title: "任务", done: false }], design: [{ id: "t2", title: "设计", done: true }] },
      advice: { topic: "先做综述", design: "对照实验" },
      stages: { topic: { status: "approved", updatedAt: 1 } },
    });

    const cleared = await store.update(uid, project.id, { plans: { topic: [] }, advice: { topic: "" } });
    expect(cleared!.plans.topic).toEqual([]);
    expect(cleared!.advice.topic).toBe("");
    expect(cleared!.plans.design).toEqual([{ id: "t2", title: "设计", done: true }]);
    expect(cleared!.advice.design).toBe("对照实验");
    expect(cleared!.stages.topic).toEqual({ status: "approved", updatedAt: 1 });

    // unmatched uid writes nothing (no upsert, no ghost project)
    const ghostId = randomUUID();
    expect(await store.update(freshUid(), project.id, { title: "入侵" })).toBeNull();
    expect(await store.update(uid, ghostId, { title: "幽灵" })).toBeNull();
    expect(await store.get(uid, ghostId)).toBeNull();
  });
});

describe("MemoryAcademicStore · literature", () => {
  it("add derives citeKey (first author surname + year) and fills defaults", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const { entry, duplicate } = await store.add(uid, "p1", {
      title: "Deep Learning",
      authors: ["San Zhang"],
      year: 2024,
    });

    expect(duplicate).toBe(false);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-/);
    expect(entry.uid).toBe(uid);
    expect(entry.projectId).toBe("p1");
    expect(entry.citeKey).toBe("zhang2024");
    expect(entry.title).toBe("Deep Learning");
    expect(entry.authors).toEqual(["San Zhang"]);
    expect(entry.year).toBe(2024);
    expect(entry.source).toBe("manual");
    expect(entry.verified).toBe(false);
    expect(entry.verifiedAt).toBeUndefined();
    expect(entry.importedAt).toBeGreaterThan(0);
    expect(entry.doi).toBeUndefined();
    expect(entry.venue).toBeUndefined();
  });

  it("add dedupes by normalized DOI first and returns the existing entry", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.add(uid, "p1", {
      title: "Original Title",
      year: 2024,
      doi: "https://doi.org/10.1/ABC",
    });
    expect(first.entry.doi).toBe("10.1/abc"); // stored normalized

    const second = await store.add(uid, "p1", {
      title: "Totally Different Title",
      year: 2020,
      doi: "10.1/abc",
    });
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.title).toBe("Original Title");
    expect(await store.list(uid, "p1")).toHaveLength(1);
  });

  it("add dedupes by normalized title + year when no DOI is present", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.add(uid, "p1", { title: "Deep   Learning", year: 2023 });
    const duplicate = await store.add(uid, "p1", { title: "deep learning", year: 2023 });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.entry.id).toBe(first.entry.id);

    const differentYear = await store.add(uid, "p1", { title: "deep learning", year: 2024 });
    expect(differentYear.duplicate).toBe(false);
    expect(await store.list(uid, "p1")).toHaveLength(2);
  });

  it("add uniquifies auto citeKeys with a/b suffixes", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const one = await store.add(uid, "p1", { title: "One", authors: ["San Zhang"], year: 2024 });
    const two = await store.add(uid, "p1", { title: "Two", authors: ["San Zhang"], year: 2024 });
    const three = await store.add(uid, "p1", { title: "Three", authors: ["San Zhang"], year: 2024 });
    expect(one.entry.citeKey).toBe("zhang2024");
    expect(two.entry.citeKey).toBe("zhang2024a");
    expect(three.entry.citeKey).toBe("zhang2024b");
  });

  it("add keeps a caller-suggested citeKey and uniquifies it case-insensitively", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.add(uid, "p1", { title: "T1", citeKey: "Smith2020", year: 2020 });
    const second = await store.add(uid, "p1", { title: "T2", citeKey: "smith2020" });
    expect(first.entry.citeKey).toBe("Smith2020");
    expect(second.entry.citeKey).toBe("smith2020a");
  });

  it("get accepts an entry id or citeKey (case-insensitive) and respects uid/project scope", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const { entry } = await store.add(uid, "p1", { title: "Scope", authors: ["San Zhang"], year: 2024 });

    expect((await store.get(uid, "p1", entry.id))?.id).toBe(entry.id);
    expect((await store.get(uid, "p1", "ZHANG2024"))?.id).toBe(entry.id);
    expect(await store.get(freshUid(), "p1", entry.id)).toBeNull();
    expect(await store.get(uid, "p2", entry.id)).toBeNull();
    expect(await store.get(uid, "p1", "missing")).toBeNull();
  });

  it("findByDoi normalizes the DOI argument and returns null for unknown/empty DOIs", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const { entry } = await store.add(uid, "p1", { title: "DOI paper", doi: "10.1000/XYZ" });

    expect((await store.findByDoi(uid, "p1", "https://doi.org/10.1000/XYZ"))?.id).toBe(entry.id);
    expect(await store.findByDoi(uid, "p1", "10.9999/none")).toBeNull();
    expect(await store.findByDoi(uid, "p1", "")).toBeNull();
    expect(await store.findByDoi(freshUid(), "p1", "10.1000/xyz")).toBeNull();
  });

  it("setVerified toggles verified/verifiedAt and returns null for unknown refs", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const { entry } = await store.add(uid, "p1", { title: "Verify", doi: "10.1000/verify" });

    const verified = await store.setVerified(uid, "p1", entry.id, true);
    expect(verified!.verified).toBe(true);
    expect(verified!.verifiedAt).toBeGreaterThan(0);

    const revoked = await store.setVerified(uid, "p1", entry.citeKey, false);
    expect(revoked!.verified).toBe(false);
    expect(revoked!.verifiedAt).toBeUndefined();

    expect(await store.setVerified(uid, "p1", "missing", true)).toBeNull();
    expect(await store.setVerified(freshUid(), "p1", entry.id, true)).toBeNull();
  });

  it("remove accepts id or citeKey and is scoped by uid", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const { entry } = await store.add(uid, "p1", { title: "Remove", authors: ["San Zhang"], year: 2024 });

    expect(await store.remove(freshUid(), "p1", entry.id)).toBe(false);
    expect(await store.remove(uid, "p1", entry.citeKey)).toBe(true);
    expect(await store.list(uid, "p1")).toEqual([]);
    expect(await store.remove(uid, "p1", entry.id)).toBe(false);
  });

  it("list orders by importedAt desc and only returns the project's entries", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.add(uid, "p1", { title: "First" });
    await sleep(5);
    const second = await store.add(uid, "p1", { title: "Second" });
    await store.add(freshUid(), "p1", { title: "Other user" });
    await store.add(uid, "p2", { title: "Other project" });

    const listed = await store.list(uid, "p1");
    expect(listed.map((entry) => entry.id)).toEqual([second.entry.id, first.entry.id]);
    expect((await store.list(uid, "p2")).map((entry) => entry.title)).toEqual(["Other project"]);
  });

  it("duplicate add returns a deep copy of the stored entry", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.add(uid, "p1", { title: "Copy", doi: "10.1/copy", authors: ["A One"] });
    const duplicate = await store.add(uid, "p1", { title: "Copy again", doi: "10.1/COPY" });

    duplicate.entry.authors.push("Injected Author");
    const read = await store.get(uid, "p1", first.entry.id);
    expect(read!.authors).toEqual(["A One"]);
  });

  it("addMany stores a whole batch and returns results in input order", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const results = await store.addMany(uid, "p1", [
      { title: "First Paper", authors: ["San Zhang"], year: 2024 },
      { title: "Second Paper", doi: "10.5/BATCH" },
      { title: "Third Paper" },
    ]);

    expect(results.map((result) => result.duplicate)).toEqual([false, false, false]);
    expect(results.map((result) => result.entry.title)).toEqual([
      "First Paper",
      "Second Paper",
      "Third Paper",
    ]);
    expect(results[0].entry.citeKey).toBe("zhang2024");
    expect(results[1].entry.doi).toBe("10.5/batch");

    // the library holds exactly the batch, newest import first
    expect((await store.list(uid, "p1")).map((entry) => entry.title)).toEqual([
      "Third Paper",
      "Second Paper",
      "First Paper",
    ]);
    expect(await store.count(uid, "p1")).toBe(3);
  });

  it("addMany dedupes against the library and within the batch (first occurrence wins)", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const existing = await store.add(uid, "p1", { title: "Existing", doi: "10.7/existing" });

    const results = await store.addMany(uid, "p1", [
      { title: "Existing again", doi: "https://doi.org/10.7/EXISTING" }, // matches the library
      { title: "Batch Item", doi: "10.7/batch" },
      { title: "Batch Item", doi: "10.7/batch" }, // duplicate inside the batch
      { title: "No DOI Paper", year: 2020 },
      { title: "no doi paper", year: 2020 }, // title+year duplicate inside the batch
    ]);

    expect(results.map((result) => result.duplicate)).toEqual([true, false, true, false, true]);
    expect(results[0].entry.id).toBe(existing.entry.id);
    expect(results[2].entry.id).toBe(results[1].entry.id);
    expect(results[4].entry.id).toBe(results[3].entry.id);
    // three distinct papers: the existing one plus two new
    expect(await store.count(uid, "p1")).toBe(3);
  });

  it("addMany uniquifies citeKeys across the batch and keeps caller arrays private", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const authors = ["San Zhang"];
    const results = await store.addMany(uid, "p1", [
      { title: "One", authors, year: 2024 },
      { title: "Two", authors, year: 2024 },
      { title: "Three", citeKey: "ZHANG2024" },
      { title: "Four", citeKey: "zhang2024" },
    ]);
    expect(results.map((result) => result.entry.citeKey)).toEqual([
      "zhang2024",
      "zhang2024a",
      "ZHANG2024b",
      "zhang2024c",
    ]);

    results[0].entry.authors.push("Injected");
    expect((await store.get(uid, "p1", results[0].entry.id))!.authors).toEqual(["San Zhang"]);
  });

  it("addMany with an empty batch returns [] and writes nothing", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    expect(await store.addMany(uid, "p1", [])).toEqual([]);
    expect(await store.count(uid, "p1")).toBe(0);
  });

  it("count is scoped by uid and project and follows remove", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    expect(await store.count(uid, "p1")).toBe(0);

    const { entry } = await store.add(uid, "p1", { title: "Counted" });
    await store.addMany(uid, "p2", [{ title: "A" }, { title: "B" }]);
    await store.add(freshUid(), "p1", { title: "Other user" });

    expect(await store.count(uid, "p1")).toBe(1);
    expect(await store.count(uid, "p2")).toBe(2);
    expect(await store.count(freshUid(), "p2")).toBe(0);
    expect(await store.count(uid, "missing")).toBe(0);

    await store.remove(uid, "p1", entry.citeKey);
    expect(await store.count(uid, "p1")).toBe(0);
    // the dedupe index is dropped with the row, so the same paper imports again
    const again = await store.add(uid, "p1", { title: "Counted" });
    expect(again.duplicate).toBe(false);
    expect(await store.count(uid, "p1")).toBe(1);
  });
});

describe("MemoryAcademicStore · documents", () => {
  it("createDocument starts empty and stamps createdAt/updatedAt", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", { kind: "draft", title: "投稿初稿" });

    expect(doc.id).toMatch(/^[0-9a-f]{8}-/);
    expect(doc.uid).toBe(uid);
    expect(doc.projectId).toBe("p1");
    expect(doc.kind).toBe("draft");
    expect(doc.title).toBe("投稿初稿");
    expect(doc.sections).toEqual([]);
    expect(doc.createdAt).toBeGreaterThan(0);
    expect(doc.updatedAt).toBe(doc.createdAt);
  });

  it("createDocument derives section keys/order/content and keeps explicit values", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", {
      kind: "proposal",
      title: "开题报告",
      sections: [
        { title: "Introduction", content: "Hello" },
        { title: "Method" },
        { key: "custom-key", title: "Results", content: "R", order: 7 },
      ],
    });

    expect(doc.sections.map((section) => section.key)).toEqual(["introduction", "method", "custom-key"]);
    expect(doc.sections.map((section) => section.order)).toEqual([0, 1, 7]);
    expect(doc.sections.map((section) => section.content)).toEqual(["Hello", "", "R"]);
    expect(doc.sections.every((section) => section.updatedAt === doc.createdAt)).toBe(true);
  });

  it("createDocument sorts sections by order and derives stable CJK keys", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", {
      kind: "custom",
      title: "中文文档",
      sections: [
        { title: "方法", order: 2 },
        { title: "引言", order: 1 },
      ],
    });
    expect(doc.sections.map((section) => section.title)).toEqual(["引言", "方法"]);
    const keys = doc.sections.map((section) => section.key);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9-_]+$/);

    // same title in a second document derives the same key (stable, not random)
    const again = await store.createDocument(uid, "p1", {
      kind: "custom",
      title: "中文文档 2",
      sections: [{ title: "引言" }],
    });
    expect(again.sections[0].key).toBe(keys[0]);
  });

  it("listDocuments is scoped by uid + project and ordered by updatedAt desc", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.createDocument(uid, "p1", { kind: "draft", title: "第一篇" });
    await sleep(5);
    const second = await store.createDocument(uid, "p1", { kind: "revision", title: "第二篇" });
    await store.createDocument(freshUid(), "p1", { kind: "draft", title: "别人的" });
    await store.createDocument(uid, "p2", { kind: "draft", title: "别的项目" });

    expect((await store.listDocuments(uid, "p1")).map((doc) => doc.id)).toEqual([second.id, first.id]);
    expect((await store.listDocuments(uid, "p2")).map((doc) => doc.title)).toEqual(["别的项目"]);
  });

  it("getDocument/updateDocument are scoped by uid", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", { kind: "draft", title: "旧标题" });
    await sleep(5);

    const updated = await store.updateDocument(uid, doc.id, { title: "新标题" });
    expect(updated!.title).toBe("新标题");
    expect(updated!.updatedAt).toBeGreaterThan(doc.updatedAt);
    expect(updated!.createdAt).toBe(doc.createdAt);

    expect(await store.updateDocument(freshUid(), doc.id, { title: "入侵" })).toBeNull();
    expect(await store.updateDocument(uid, "missing-document", { title: "x" })).toBeNull();
    expect(await store.getDocument(freshUid(), doc.id)).toBeNull();
    expect((await store.getDocument(uid, doc.id))!.title).toBe("新标题");
  });

  it("upsertSection appends new sections and updates existing ones by key", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", { kind: "draft", title: "章节" });

    let updated = await store.upsertSection(uid, doc.id, { title: "Abstract", content: "A" });
    expect(updated!.sections).toHaveLength(1);
    expect(updated!.sections[0]).toMatchObject({ key: "abstract", title: "Abstract", content: "A", order: 0 });

    updated = await store.upsertSection(uid, doc.id, { title: "Method", content: "M" });
    expect(updated!.sections.map((section) => section.key)).toEqual(["abstract", "method"]);
    expect(updated!.sections[1].order).toBe(1);

    // existing key keeps its order, updates title/content
    updated = await store.upsertSection(uid, doc.id, { key: "method", title: "方法", content: "M2" });
    expect(updated!.sections).toHaveLength(2);
    expect(updated!.sections[1]).toMatchObject({ key: "method", title: "方法", content: "M2", order: 1 });
  });

  it("upsertSection honours an explicit order and re-sorts sections", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", {
      kind: "draft",
      title: "排序",
      sections: [{ title: "First", order: 0 }, { title: "Second", order: 1 }],
    });

    const updated = await store.upsertSection(uid, doc.id, { key: "first", title: "First", content: "x", order: 5 });
    expect(updated!.sections.map((section) => section.key)).toEqual(["second", "first"]);
    expect(updated!.sections[1].order).toBe(5);
  });

  it("upsertSection returns null for unknown or foreign documents", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", { kind: "draft", title: "边界" });

    expect(await store.upsertSection(freshUid(), doc.id, { title: "Section" })).toBeNull();
    expect(await store.upsertSection(uid, "missing-document", { title: "Section" })).toBeNull();
  });

  it("deleteSection removes a section, keeps order and leaves unknown keys untouched", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", {
      kind: "draft",
      title: "删除",
      sections: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    await sleep(5);

    const removed = await store.deleteSection(uid, doc.id, "two");
    expect(removed!.sections.map((section) => section.key)).toEqual(["one", "three"]);
    expect(removed!.updatedAt).toBeGreaterThan(doc.updatedAt);

    const untouched = await store.deleteSection(uid, doc.id, "missing");
    expect(untouched!.sections).toHaveLength(2);
    expect(untouched!.updatedAt).toBe(removed!.updatedAt); // no mutation, no timestamp bump

    expect(await store.deleteSection(freshUid(), doc.id, "one")).toBeNull();
    expect(await store.deleteSection(uid, "missing-document", "one")).toBeNull();
  });

  it("document word count follows the shared wordCount helper", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const doc = await store.createDocument(uid, "p1", {
      kind: "draft",
      title: "字数",
      sections: [
        { title: "Abstract", content: "Hello world" },
        { title: "Introduction", content: "你好世界" },
      ],
    });
    const total = doc.sections.reduce((sum, section) => sum + wordCount(section.content), 0);
    expect(total).toBe(6); // 2 latin words + 4 CJK characters
  });

  it("countDocuments is scoped by uid + project and counts without listing", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    expect(await store.countDocuments(uid, "p1")).toBe(0);

    await store.createDocument(uid, "p1", { kind: "draft", title: "A" });
    await store.createDocument(uid, "p1", { kind: "revision", title: "B" });
    await store.createDocument(freshUid(), "p1", { kind: "draft", title: "C" });
    await store.createDocument(uid, "p2", { kind: "draft", title: "D" });

    expect(await store.countDocuments(uid, "p1")).toBe(2);
    expect(await store.countDocuments(uid, "p2")).toBe(1);
    expect(await store.countDocuments(uid, "missing")).toBe(0);
    expect(await store.countDocuments(freshUid(), "p2")).toBe(0);
  });
});

describe("MemoryAcademicStore · events", () => {
  it("append defaults to actor agent and an empty payload", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const event = await store.append(uid, "p1", "project.created");

    expect(event.id).toMatch(/^[0-9a-f]{8}-/);
    expect(event.uid).toBe(uid);
    expect(event.projectId).toBe("p1");
    expect(event.type).toBe("project.created");
    expect(event.payload).toEqual({});
    expect(event.actor).toBe("agent");
    expect(event.createdAt).toBeGreaterThan(0);
  });

  it("append accepts a custom actor and payload", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const event = await store.append(
      uid,
      "p1",
      "stage.updated",
      { stage: "design", status: "submitted" },
      "user",
    );
    expect(event.actor).toBe("user");
    expect(event.payload).toEqual({ stage: "design", status: "submitted" });
  });

  it("list is newest-first (stable for same-millisecond appends) and honours limit", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const first = await store.append(uid, "p1", "one");
    const second = await store.append(uid, "p1", "two");
    const third = await store.append(uid, "p1", "three");

    expect((await store.listEvents(uid, "p1", 10)).map((event) => event.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect((await store.listEvents(uid, "p1", 2)).map((event) => event.type)).toEqual(["three", "two"]);
    expect(await store.listEvents(uid, "p1", 0)).toEqual([]);
  });

  it("list is scoped by uid and project", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const otherUid = freshUid();
    await store.append(uid, "p1", "mine");
    await store.append(otherUid, "p1", "other user");
    await store.append(uid, "p2", "other project");

    expect((await store.listEvents(uid, "p1", 10)).map((event) => event.type)).toEqual(["mine"]);
    expect((await store.listEvents(uid, "p2", 10)).map((event) => event.type)).toEqual(["other project"]);
    expect((await store.listEvents(otherUid, "p1", 10)).map((event) => event.type)).toEqual(["other user"]);
  });

  it("payload is deep-copied on write and on read", async () => {
    const store = new MemoryAcademicStore();
    const uid = freshUid();
    const payload = { detail: { title: "原始" } };
    const event = await store.append(uid, "p1", "custom", payload);

    payload.detail.title = "写入后篡改";
    event.payload.detail = { title: "读取后篡改" };

    const listed = await store.listEvents(uid, "p1", 10);
    expect((listed[0].payload.detail as { title: string }).title).toBe("原始");
  });
});

// ---------------------------------------------------------------------------
// Composition: one instance must satisfy all four interfaces (container wiring)
// ---------------------------------------------------------------------------

describe("academic store composition", () => {
  it("a single MemoryAcademicStore instance serves all four repositories", async () => {
    const store = new MemoryAcademicStore();
    const projects: AcademicProjectRepository = store;
    const literature: AcademicLiteratureRepository = store;
    const documents: AcademicDocumentRepository = store;
    const events: AcademicEventRepository = store;
    const uid = freshUid();

    const project = await projects.create(uid, { title: "联合实例" });
    await literature.add(uid, project.id, { title: "Paper", doi: "10.1/joined" });
    await documents.createDocument(uid, project.id, { kind: "draft", title: "稿件" });
    await events.append(uid, project.id, "project.created", { title: project.title }, "agent");

    expect(await projects.list(uid)).toHaveLength(1);
    expect(await literature.list(uid, project.id)).toHaveLength(1);
    expect(await documents.listDocuments(uid, project.id)).toHaveLength(1);
    expect(await events.listEvents(uid, project.id, 10)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mongo adapter (skipped when no local MongoDB is reachable)
// ---------------------------------------------------------------------------

let mongo: import("../src/repository/mongo/academic.js").MongoAcademicStore | null = null;

beforeAll(async () => {
  const { MongoAcademicStore } = await import("../src/repository/mongo/academic.js");
  mongo = await MongoAcademicStore.connect();
}, 15_000);

afterAll(async () => {
  await mongo?.close();
});

describe("MongoAcademicStore", () => {
  it("connect returns a store (or the whole group skips without MongoDB)", (ctx) => {
    if (!mongo) return ctx.skip();
    expect(mongo).toBeInstanceOf(Object);
  });

  it("projects: create → get → patch merge → list → remove", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const created = await mongo.create(uid, { title: "Mongo 项目", paperType: "thesis", field: "NLP" });
    expect(created.stage).toBe("topic");
    expect(created.stages.topic.status).toBe("active");
    expect(created.stages.design.status).toBe("locked");

    const fetched = await mongo.get(uid, created.id);
    expect(fetched!.title).toBe("Mongo 项目");
    expect(await mongo.get(freshUid(), created.id)).toBeNull();

    const updated = await mongo.update(uid, created.id, {
      title: "Mongo 项目（改）",
      stages: { design: { status: "active", updatedAt: 1 } },
      plans: { topic: [{ id: "t1", title: "任务", done: false }] },
      advice: { topic: "建议" },
    });
    expect(updated!.title).toBe("Mongo 项目（改）");
    expect(updated!.stage).toBe("topic");
    expect(updated!.stages.design).toEqual({ status: "active", updatedAt: 1 });
    expect(updated!.stages.topic.status).toBe("active");
    expect(updated!.plans.topic).toEqual([{ id: "t1", title: "任务", done: false }]);
    expect(updated!.advice.topic).toBe("建议");
    expect(await mongo.update(freshUid(), created.id, { title: "入侵" })).toBeNull();

    expect((await mongo.list(uid)).map((project) => project.id)).toEqual([created.id]);
    expect(await mongo.remove(freshUid(), created.id)).toBe(false);
    expect(await mongo.remove(uid, created.id)).toBe(true);
    expect(await mongo.get(uid, created.id)).toBeNull();
  });

  it("literature: DOI dedupe, citeKey suffix, findByDoi, setVerified, remove", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const first = await mongo.add(uid, "p1", {
      title: "Mongo Paper",
      authors: ["San Zhang"],
      year: 2024,
      doi: "https://doi.org/10.9/ABC",
    });
    expect(first.duplicate).toBe(false);
    expect(first.entry.doi).toBe("10.9/abc");
    expect(first.entry.citeKey).toBe("zhang2024");

    const second = await mongo.add(uid, "p1", { title: "Mongo Paper", year: 2024, doi: "10.9/abc" });
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);

    const third = await mongo.add(uid, "p1", { title: "Another", authors: ["San Zhang"], year: 2024 });
    expect(third.entry.citeKey).toBe("zhang2024a");

    expect((await mongo.get(uid, "p1", "ZHANG2024"))?.id).toBe(first.entry.id);
    expect((await mongo.findByDoi(uid, "p1", "https://doi.org/10.9/ABC"))?.id).toBe(first.entry.id);
    expect(await mongo.findByDoi(uid, "p1", "10.9/none")).toBeNull();

    const verified = await mongo.setVerified(uid, "p1", first.entry.id, true);
    expect(verified!.verified).toBe(true);
    expect(verified!.verifiedAt).toBeGreaterThan(0);
    const revoked = await mongo.setVerified(uid, "p1", first.entry.id, false);
    expect(revoked!.verified).toBe(false);
    expect(revoked!.verifiedAt).toBeUndefined();

    expect((await mongo.list(uid, "p1")).map((entry) => entry.id)).toEqual([
      third.entry.id,
      first.entry.id,
    ]);
    expect(await mongo.remove(freshUid(), "p1", first.entry.id)).toBe(false);
    expect(await mongo.remove(uid, "p1", first.entry.citeKey)).toBe(true);
    expect(await mongo.get(uid, "p1", first.entry.id)).toBeNull();
  });

  it("documents: create → upsertSection new/update → deleteSection", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const project = await mongo.create(uid, { title: "Mongo 稿件项目" });
    const doc = await mongo.createDocument(uid, project.id, { kind: "draft", title: "Mongo 稿件" });
    expect(doc.sections).toEqual([]);

    let updated = await mongo.upsertSection(uid, doc.id, { title: "Abstract", content: "A" });
    expect(updated!.sections.map((section) => section.key)).toEqual(["abstract"]);
    updated = await mongo.upsertSection(uid, doc.id, { title: "Method", content: "M" });
    expect(updated!.sections.map((section) => section.key)).toEqual(["abstract", "method"]);
    updated = await mongo.upsertSection(uid, doc.id, { key: "method", title: "方法", content: "M2" });
    expect(updated!.sections[1]).toMatchObject({ key: "method", title: "方法", content: "M2", order: 1 });

    expect((await mongo.listDocuments(uid, project.id)).map((d) => d.id)).toEqual([doc.id]);
    expect(await mongo.getDocument(freshUid(), doc.id)).toBeNull();

    const removed = await mongo.deleteSection(uid, doc.id, "abstract");
    expect(removed!.sections.map((section) => section.key)).toEqual(["method"]);
  });

  it("events: append order and limit", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const first = await mongo.append(uid, "p1", "one", {}, "agent");
    const second = await mongo.append(uid, "p1", "two", { index: 2 }, "user");
    const third = await mongo.append(uid, "p1", "three");

    const listed = await mongo.listEvents(uid, "p1", 10);
    expect(listed.map((event) => event.id)).toEqual([third.id, second.id, first.id]);
    expect(listed[1].actor).toBe("user");
    expect(listed[1].payload).toEqual({ index: 2 });
    expect((await mongo.listEvents(uid, "p1", 2)).map((event) => event.type)).toEqual(["three", "two"]);
    expect(await mongo.listEvents(uid, "p1", 0)).toEqual([]);
  });

  it("projects: update is one $set (clears plans/advice, keeps siblings, null when unmatched)", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const created = await mongo.create(uid, { title: "$set 语义", field: "旧领域" });
    await mongo.update(uid, created.id, {
      plans: {
        topic: [{ id: "t1", title: "任务", done: false }],
        design: [{ id: "t2", title: "设计", done: true }],
      },
      advice: { topic: "先做综述", design: "对照实验" },
      stages: { design: { status: "active", updatedAt: 7 } },
    });
    await sleep(5);

    const cleared = await mongo.update(uid, created.id, { plans: { topic: [] }, advice: { topic: "" } });
    expect(cleared!.plans.topic).toEqual([]); // empty array written, not skipped
    expect(cleared!.advice.topic).toBe(""); // empty string written, not skipped
    expect(cleared!.plans.design).toEqual([{ id: "t2", title: "设计", done: true }]); // sibling untouched
    expect(cleared!.advice.design).toBe("对照实验");
    expect(cleared!.stages.design).toEqual({ status: "active", updatedAt: 7 });
    expect(cleared!.field).toBe("旧领域"); // untouched root field preserved
    expect(cleared!.createdAt).toBe(created.createdAt);
    expect(cleared!.updatedAt).toBeGreaterThan(created.updatedAt);

    // a provided stage state replaces the stored one wholesale (no deep merge)
    const stageSwap = await mongo.update(uid, created.id, {
      stages: { design: { status: "frozen", updatedAt: 9 } },
    });
    expect(stageSwap!.stages.design).toEqual({ status: "frozen", updatedAt: 9 });

    // unmatched uid / unknown id write nothing (upsert off, no ghost row)
    const ghostId = randomUUID();
    expect(await mongo.update(freshUid(), created.id, { title: "入侵" })).toBeNull();
    expect(await mongo.update(uid, ghostId, { title: "幽灵" })).toBeNull();
    expect(await mongo.get(uid, ghostId)).toBeNull();
    expect((await mongo.get(uid, created.id))!.title).toBe("$set 语义");
  });

  it("literature: addMany batches, dedupes (library + batch) and keeps input order", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const existing = await mongo.add(uid, "p1", { title: "Mongo Existing", doi: "10.11/EXIST" });

    const results = await mongo.addMany(uid, "p1", [
      { title: "Mongo Existing again", doi: "10.11/exist" },
      { title: "Mongo Batch A", doi: "10.11/a" },
      { title: "Mongo Batch A", doi: "10.11/a" },
      { title: "Mongo Batch B", year: 2021 },
      { title: "mongo batch b", year: 2021 },
    ]);
    expect(results.map((result) => result.duplicate)).toEqual([true, false, true, false, true]);
    expect(results[0].entry.id).toBe(existing.entry.id);
    expect(results[2].entry.id).toBe(results[1].entry.id);
    expect(results[4].entry.id).toBe(results[3].entry.id);
    expect(results[1].entry.doi).toBe("10.11/a");

    expect(await mongo.count(uid, "p1")).toBe(3);
    expect(await mongo.count(freshUid(), "p1")).toBe(0);
    expect(await mongo.count(uid, "p2")).toBe(0);
    // newest import first: batch rows were accepted after the existing one
    expect((await mongo.list(uid, "p1")).map((entry) => entry.title)).toEqual([
      "Mongo Batch B",
      "Mongo Batch A",
      "Mongo Existing",
    ]);
    expect(await mongo.addMany(uid, "p1", [])).toEqual([]);
  });

  it("literature: addMany uniquifies citeKeys inside the batch", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const results = await mongo.addMany(uid, "p1", [
      { title: "Batch Key One", authors: ["San Zhang"], year: 2024 },
      { title: "Batch Key Two", authors: ["San Zhang"], year: 2024 },
    ]);
    expect(results.map((result) => result.entry.citeKey)).toEqual(["zhang2024", "zhang2024a"]);
  });

  it("documents: countDocuments is scoped by uid + project", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    expect(await mongo.countDocuments(uid, "p1")).toBe(0);
    await mongo.createDocument(uid, "p1", { kind: "draft", title: "Mongo A" });
    await mongo.createDocument(uid, "p1", { kind: "proposal", title: "Mongo B" });
    await mongo.createDocument(freshUid(), "p1", { kind: "draft", title: "Mongo C" });
    await mongo.createDocument(uid, "p2", { kind: "draft", title: "Mongo D" });

    expect(await mongo.countDocuments(uid, "p1")).toBe(2);
    expect(await mongo.countDocuments(uid, "p2")).toBe(1);
    expect(await mongo.countDocuments(uid, "missing")).toBe(0);
  });
});
