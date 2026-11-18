import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { AcademicService } from "../src/services/research/academic.js";
import { SubmissionPackageService } from "../src/services/research/submission-package.js";
import type { AcademicValidationReport } from "../src/services/research/research-validation.js";

function report(pass: boolean): AcademicValidationReport {
  return {
    pass,
    citations: { total: 1, missing: [], unverified: [] },
    runs: { total: 0, unreproducible: [], invalidRefs: [] },
    results: { sections: ["结果"], withoutEvidenceRef: [] },
    sectionsWithNumbers: ["结果"],
    sectionsMissingRunRef: [],
  };
}

async function seed() {
  const store = new MemoryAcademicStore();
  const project = await store.create("u1", { title: "测试论文", citationStyle: "apa" });
  await store.add("u1", project.id, { title: "A Survey", authors: ["San Zhang"], year: 2024, doi: "10.1/x" });
  const doc = await store.createDocument("u1", project.id, { kind: "draft", title: "初稿" });
  await store.upsertSection("u1", doc.id, { key: "intro", title: "引言", content: "正文" });
  const service = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: {} as never,
  });
  return { store, project, doc, service };
}

describe("bibliography in exports", () => {
  it("appends a 参考文献 section with the project citation style", async () => {
    const { doc, service } = await seed();
    const markdown = await service.exportDocument("u1", doc.id, "markdown");
    expect(markdown.text).toContain("## 参考文献");
    expect(markdown.text).toContain("Zhang, S. (2024). A Survey.");
    const latex = await service.exportDocument("u1", doc.id, "latex");
    expect(latex.text).toContain("\\section*{参考文献}");
    expect(latex.text).toContain("2024");
  });
});

describe("submission package", () => {
  it("builds a zip with docx/markdown/latex/bib and consumes one approval", async () => {
    const { store, project, doc, service } = await seed();
    let consumed = 0;
    const pkg = new SubmissionPackageService({
      academic: service,
      docx: { exportDocxBuffer: async () => ({ buffer: Buffer.from("docx"), title: "初稿", fileName: "x.docx" }) } as never,
      validation: { validate: async () => report(true) },
      approvals: {
        consume: async () => {
          consumed += 1;
          return { id: "approval-1", projectId: project.id } as never;
        },
      } as never,
    });
    const result = await pkg.build("u1", doc.id);
    expect(result.approvalId).toBe("approval-1");
    expect(consumed).toBe(1);
    expect(result.fileName).toContain("submission.zip");
    const zip = await JSZip.loadAsync(result.bytes);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(["manuscript.docx", "manuscript.md", "manuscript.tex", "references.bib", "README.txt"]),
    );
    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("校验通过");
  });

  it("rejects when validation fails without consuming the approval", async () => {
    const { doc, service } = await seed();
    let consumed = 0;
    const pkg = new SubmissionPackageService({
      academic: service,
      docx: { exportDocxBuffer: async () => ({ buffer: Buffer.from("docx"), title: "t", fileName: "x.docx" }) } as never,
      validation: { validate: async () => report(false) },
      approvals: {
        consume: async () => {
          consumed += 1;
          return {} as never;
        },
      } as never,
    });
    await expect(pkg.build("u1", doc.id)).rejects.toMatchObject({ status: 409 });
    expect(consumed).toBe(0);
  });
});
