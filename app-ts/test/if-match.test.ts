import { describe, expect, it } from "vitest";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { AcademicService } from "../src/services/research/academic.js";

function service(store: MemoryAcademicStore): AcademicService {
  return new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: {} as never,
  });
}

describe("optimistic concurrency (If-Match)", () => {
  it("rejects a project update based on a stale updatedAt", async () => {
    const store = new MemoryAcademicStore();
    const api = service(store);
    const created = await api.createProject("u1", { title: "t" });
    const version = created.project.updatedAt;
    const updated = await api.updateProject("u1", created.project.id, { field: "a" }, version);
    expect(updated.project.field).toBe("a");
    await expect(api.updateProject("u1", created.project.id, { field: "b" }, version)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects a section save based on a stale document updatedAt", async () => {
    const store = new MemoryAcademicStore();
    const api = service(store);
    const project = await api.createProject("u1", { title: "t" });
    const created = await api.createDocument("u1", project.project.id, { kind: "draft", title: "d" });
    const version = created.document.updatedAt;
    await api.saveSection("u1", created.document.id, { title: "引言", content: "正文" }, version);
    await expect(
      api.saveSection("u1", created.document.id, { title: "方法", content: "正文" }, version),
    ).rejects.toMatchObject({ status: 409 });
  });
});
