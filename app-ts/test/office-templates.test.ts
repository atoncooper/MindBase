import { describe, expect, it } from "vitest";

import { DOCUMENT_TEMPLATE_IDS } from "../src/services/office/ir.js";
import {
  DEFAULT_TEMPLATE_REGISTRY,
  DOC_TEMPLATES,
  getDocTemplate,
  resolveTemplate,
} from "../src/services/office/templates.js";
import { loadTemplateOverrides } from "../src/services/office/template-overrides.js";
import { createOfficeListTemplatesTool } from "../src/tools/office/templates.js";

const LOGO_UUID = "logo-upload-uuid-0001";
const WORK_REPORT = DOC_TEMPLATES["work-report"];

async function listContent(tool: ReturnType<typeof createOfficeListTemplatesTool>): Promise<string> {
  const result = await tool.execute({} as never, {} as never);
  return typeof result === "string" ? result : result.content;
}

function builtInsSnapshot(): string {
  return JSON.stringify(DOC_TEMPLATES);
}

describe("template registry baseline", () => {
  it("keeps the eight built-in templates and the stock resolution rules", () => {
    expect(Object.keys(DOC_TEMPLATES)).toHaveLength(8);
    expect(DOCUMENT_TEMPLATE_IDS).toHaveLength(8);
    expect(getDocTemplate("proposal").id).toBe("business-plan");
    expect(getDocTemplate(undefined, DEFAULT_TEMPLATE_REGISTRY).id).toBe("work-report");
    expect(resolveTemplate({ titleHint: "用户调研报告" }).template.id).toBe("research-report");
    expect(resolveTemplate({ requested: "notice" }).reason).toBe("explicit");
  });
});

describe("external template overrides", () => {
  it("merges a valid override and lets brand.primaryColor win over typography.accentColor", () => {
    const before = builtInsSnapshot();
    const result = loadTemplateOverrides({
      version: 1,
      templates: {
        "work-report": {
          label: "企业季度报告（品牌版）",
          description: "品牌定制的工作报告版式。",
          aliases: ["brand-report"],
          keywords: ["品牌报告"],
          page: { marginsCm: { left: 3.2 } },
          typography: { bodySizePt: 11, accentColor: "#112233" },
          cover: { spaceBeforeTwips: 1800 },
          headerFooter: { footerText: "内部资料" },
          toc: { enabled: true, depth: 3 },
          table: { borderColor: "#ababab" },
          numbering: { style: "decimal" },
          listGlyph: "square",
          brand: { primaryColor: "#445566", logoUploadUuid: LOGO_UUID },
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.appliedTemplateIds).toEqual(["work-report"]);

    const template = result.registry.templates["work-report"];
    expect(template.label).toBe("企业季度报告（品牌版）");
    expect(template.description).toBe("品牌定制的工作报告版式。");
    expect(template.typography.bodySizePt).toBe(11);
    expect(template.typography.accentColor).toBe("445566");
    expect(template.brand).toEqual({ primaryColor: "445566", logoUploadUuid: LOGO_UUID });
    expect(template.page.margins.left).toBe(Math.round(3.2 * 567));
    expect(template.page.margins.top).toBe(WORK_REPORT.page.margins.top);
    expect(template.cover.spaceBeforeTwips).toBe(1800);
    expect(template.cover.enabled).toBe(WORK_REPORT.cover.enabled);
    expect(template.headerFooter.footerText).toBe("内部资料");
    expect(template.toc.depth).toBe(3);
    expect(template.table.borderColor).toBe("ABABAB");
    expect(template.numbering.style).toBe("decimal");
    expect(template.listGlyph).toBe("square");

    // New alias + stock aliases both resolve; label (Chinese) resolves too.
    expect(getDocTemplate("brand-report", result.registry).id).toBe("work-report");
    expect(getDocTemplate("report", result.registry).id).toBe("work-report");
    expect(getDocTemplate("企业季度报告（品牌版）", result.registry).id).toBe("work-report");
    expect(resolveTemplate({ requested: "brand-report" }, result.registry)).toEqual({
      template,
      reason: "explicit",
    });

    // Built-in constants are untouched (new registry view, no mutation).
    expect(builtInsSnapshot()).toBe(before);
    expect(WORK_REPORT.brand).toBeUndefined();
  });

  it("deep-merges nested maps and appends aliases/keywords without losing built-ins", () => {
    const result = loadTemplateOverrides({
      version: 1,
      templates: {
        academic: {
          aliases: ["brand-paper", "Paper"],
          keywords: ["品牌学术"],
          typography: { headingSizesPt: { h2: 15 }, headingColors: { h1: "#AA0000" } },
        },
      },
    });
    expect(result.errors).toEqual([]);
    const template = result.registry.templates.academic;
    expect(template.aliases).toContain("brand-paper");
    expect(template.aliases).toContain("paper");
    expect(template.aliases.filter((alias) => alias.toLowerCase() === "paper")).toHaveLength(1);
    expect(template.aliases).toContain("academic-paper");
    expect(template.keywords).toContain("品牌学术");
    expect(template.keywords).toContain("论文");
    expect(template.typography.headingSizesPt.h2).toBe(15);
    expect(template.typography.headingSizesPt.h1).toBe(DOC_TEMPLATES.academic.typography.headingSizesPt.h1);
    expect(template.typography.headingColors.h1).toBe("AA0000");
    expect(template.typography.headingColors.h2).toBe(DOC_TEMPLATES.academic.typography.headingColors.h2);
    expect(template.typography.bodySizePt).toBe(DOC_TEMPLATES.academic.typography.bodySizePt);
  });

  it("accepts raw JSON text as well as a parsed object", () => {
    const result = loadTemplateOverrides(
      JSON.stringify({ version: 1, templates: { notice: { typography: { bodySizePt: 14 } } } }),
    );
    expect(result.errors).toEqual([]);
    expect(result.appliedTemplateIds).toEqual(["notice"]);
    expect(result.registry.templates.notice.typography.bodySizePt).toBe(14);
  });

  it("leaves the base registry intact when the file itself is invalid", () => {
    const malformed = loadTemplateOverrides("{ not json");
    expect(malformed.errors[0]).toContain("不是合法 JSON");
    expect(malformed.registry).toBe(DEFAULT_TEMPLATE_REGISTRY);

    const emptyInput = loadTemplateOverrides(null);
    expect(emptyInput.errors.join("；")).toContain("JSON 对象");
    expect(emptyInput.registry).toBe(DEFAULT_TEMPLATE_REGISTRY);

    const wrongVersion = loadTemplateOverrides({ version: 2, templates: {} });
    expect(wrongVersion.errors.join("；")).toContain("version 必须为 1");
    expect(wrongVersion.registry).toBe(DEFAULT_TEMPLATE_REGISTRY);

    const noTemplates = loadTemplateOverrides({ version: 1 });
    expect(noTemplates.errors.join("；")).toContain("templates 必须是对象");
    expect(noTemplates.registry).toBe(DEFAULT_TEMPLATE_REGISTRY);
  });

  it("rejects a template atomically when one of its fields is invalid", () => {
    const result = loadTemplateOverrides({
      version: 1,
      templates: {
        academic: {
          typography: { bodySizePt: 11, accentColor: "not-a-color" },
          page: { size: "A5" },
        },
      },
    });
    const joined = result.errors.join("；");
    expect(joined).toContain("templates.academic.page.size");
    expect(joined).toContain("templates.academic.typography.accentColor");
    expect(result.appliedTemplateIds).toEqual([]);
    expect(result.registry.templates.academic).toBe(DEFAULT_TEMPLATE_REGISTRY.templates.academic);
    expect(result.registry.templates.academic.typography.bodySizePt).toBe(
      DOC_TEMPLATES.academic.typography.bodySizePt,
    );

    const badBrand = loadTemplateOverrides({
      version: 1,
      templates: { resume: { brand: { primaryColor: "#12345", logoUploadUuid: 5 } } },
    });
    expect(badBrand.errors.join("；")).toContain("templates.resume.brand.primaryColor");
    expect(badBrand.errors.join("；")).toContain("templates.resume.brand.logoUploadUuid");
    expect(badBrand.appliedTemplateIds).toEqual([]);
  });

  it("ignores unknown template ids and unknown fields with warnings", () => {
    const result = loadTemplateOverrides({
      version: 1,
      extraRootField: true,
      templates: {
        "not-a-template": { label: "x" },
        notice: { unknownField: 1, typography: { bodySizePt: 13 } },
      },
    });
    expect(result.errors).toEqual([]);
    const warnings = result.warnings.join("；");
    expect(warnings).toContain("未知模板 not-a-template");
    expect(warnings).toContain("templates.notice.unknownField");
    expect(warnings).toContain("配置.extraRootField");
    expect(result.appliedTemplateIds).toEqual(["notice"]);
    expect(result.registry.templates.notice.typography.bodySizePt).toBe(13);
    expect(result.registry.templates["work-report"]).toBe(DEFAULT_TEMPLATE_REGISTRY.templates["work-report"]);
  });

  it("treats an empty override object as a no-op with a warning", () => {
    const result = loadTemplateOverrides({ version: 1, templates: { resume: {} } });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("；")).toContain("没有可合并的字段");
    expect(result.appliedTemplateIds).toEqual([]);
    expect(result.registry.templates.resume).toBe(DEFAULT_TEMPLATE_REGISTRY.templates.resume);
  });
});

describe("office_list_templates tool", () => {
  it("lists the eight built-in templates with ids, labels and brand state", async () => {
    const tool = createOfficeListTemplatesTool();
    expect(tool.name).toBe("office_list_templates");
    const content = await listContent(tool);
    expect(content).toContain("共 8 个");
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      expect(content).toContain(id);
      expect(content).toContain(DOC_TEMPLATES[id].label);
    }
    expect(content).toContain("默认模板：work-report");
    expect(content).toContain("品牌状态：未配置品牌模板");
    expect(content).not.toContain("品牌化（");
  });

  it("reports deployment branding from the merged registry", async () => {
    const loaded = loadTemplateOverrides({
      version: 1,
      templates: { resume: { brand: { primaryColor: "#102030" } } },
    });
    expect(loaded.errors).toEqual([]);
    const tool = createOfficeListTemplatesTool({ registry: loaded.registry });
    const content = await listContent(tool);
    expect(content).toContain("品牌状态：已品牌化 1 个模板（resume）");
    expect(content).toContain("主色 #102030");
    expect(content).toContain("品牌化（主色 #102030）");
  });
});
