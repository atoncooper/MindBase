import { describe, expect, it } from "vitest";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { AcademicService } from "../src/services/research/academic.js";
import { ResearchMetrics } from "../src/services/research/metrics.js";

function service(store: MemoryAcademicStore): AcademicService {
  return new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: {} as never,
  });
}

describe("project backup export", () => {
  it("returns project, literature, documents and events", async () => {
    const store = new MemoryAcademicStore();
    const api = service(store);
    const created = await api.createProject("u1", { title: "备份项目" });
    await api.addLiterature("u1", created.project.id, { title: "Paper", authors: ["A"], year: 2024 });
    await api.createDocument("u1", created.project.id, { kind: "draft", title: "初稿" });
    const backup = await api.exportProject("u1", created.project.id);
    expect(backup.version).toBe(1);
    expect(backup.project.title).toBe("备份项目");
    expect(backup.literature).toHaveLength(1);
    expect(backup.documents.length).toBeGreaterThan(0);
    expect(backup.events.length).toBeGreaterThan(0);
    expect(new Date(backup.exportedAt).toString()).not.toBe("Invalid Date");
  });

  it("rejects a foreign project", async () => {
    const store = new MemoryAcademicStore();
    const api = service(store);
    const created = await api.createProject("u1", { title: "t" });
    await expect(api.exportProject("u2", created.project.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("research metrics", () => {
  it("counts increments and snapshots", () => {
    const metrics = new ResearchMetrics();
    metrics.inc("validation_pass");
    metrics.inc("validation_pass", 2);
    expect(metrics.snapshot().counters).toEqual({ validation_pass: 3 });
  });
});
