import { describe, expect, it } from "vitest";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";
import { ResearchApprovalError } from "../src/services/research/research-approval.js";

const document = {
  id: "d1",
  uid: "u1",
  projectId: "p1",
  kind: "draft",
  title: "测试论文",
  sections: [{ key: "intro", title: "引言", content: "正文", order: 0, updatedAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
} as never;

function report(pass: boolean) {
  return {
    pass,
    citations: { total: 0, missing: [], unverified: [] },
    runs: { total: 0, unreproducible: [], invalidRefs: [] },
    results: { sections: [], withoutEvidenceRef: [] },
    sectionsWithNumbers: [],
    sectionsMissingRunRef: [],
  };
}

function build(overrides: {
  validationPass?: boolean;
  consumeError?: boolean;
  exportError?: boolean;
} = {}) {
  const events: Array<{ type: string }> = [];
  let consumed = 0;
  const tool = createAcademicManuscriptTool({
    documents: { getDocument: async () => document } as never,
    projects: { get: async () => ({ id: "p1", uid: "u1", title: "t" }) } as never,
    events: { append: async (_u: string, _p: string, type: string) => { events.push({ type }); } } as never,
    validation: { validate: async () => report(overrides.validationPass !== false) } as never,
    approvals: {
      consume: async () => {
        consumed += 1;
        if (overrides.consumeError) throw new ResearchApprovalError("没有已批准的人工审批，请先申请并等待用户批准", "unavailable");
        return { id: "appr-1", status: "approved" } as never;
      },
    } as never,
    docx: {
      exportDocxToCloud: async () => {
        if (overrides.exportError) throw new Error("cloud gone");
        return { uploadUuid: "up-1", fileName: "论文.docx", folderId: 9, createdAt: 1 };
      },
    } as never,
  });
  return { tool, events, consumedCount: () => consumed };
}

const ctx = { uid: "u1", collector: { pushArtifacts: () => {} } } as never;
const args = { action: "submit", projectId: "p1", documentId: "d1" } as never;

describe("manuscript submit gate (submission approval)", () => {
 it("rejects submission when validation fails (approval is not consumed)", async () => {
    const { tool, consumedCount } = build({ validationPass: false });
    const result = await tool.execute(args, ctx);
    expect(String(result)).toContain("提交被拒绝");
    expect(consumedCount()).toBe(0);
  });

 it("rejects submission when no submission approval was granted", async () => {
    const { tool } = build({ consumeError: true });
    const result = await tool.execute(args, ctx);
    expect(String(result)).toContain("提交被拒绝");
    expect(String(result)).toContain("审批");
  });

 it("submits, consumes exactly one approval and records the audit event", async () => {
    const { tool, events, consumedCount } = build();
    const result = await tool.execute(args, ctx);
    expect(consumedCount()).toBe(1);
    expect(String((result as { content?: string }).content ?? result)).toContain("已提交稿件");
    expect(events.some((event) => event.type === "manuscript.submitted")).toBe(true);
  });
});
