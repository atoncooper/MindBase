import { z } from "zod";

import {
  DEFAULT_TEMPLATE_REGISTRY,
  type DocTemplate,
  type DocTemplateRegistry,
} from "../../services/office/templates.js";
import { defineTool } from "../base.js";

/**
 * office_list_templates: the template menu for Word generation.
 *
 * The DOCX export path resolves a template from an explicit id/alias, a style
 * hint or keyword inference. Without this tool the model has to guess ids it
 * cannot see, so "用学术论文的版式" often produced the default template. The
 * tool is read-only and cheap: it renders the registry (built-ins, or built-ins
 * plus deployment overrides) as compact Chinese text for the model to choose
 * from, including which templates carry the deployment's brand.
 *
 * Registration happens in the composition root, not here.
 */

export interface OfficeListTemplatesToolOptions {
  /** Registry to list (built-ins plus deployment overrides). Defaults to the built-ins. */
  registry?: DocTemplateRegistry;
}

/** "内置配色" or "品牌化（主色 #1F4E79，logo 已配置）". */
function brandState(template: DocTemplate): string {
  if (!template.brand) return "内置配色";
  const parts: string[] = [];
  if (template.brand.primaryColor) parts.push("主色 #" + template.brand.primaryColor);
  if (template.brand.logoUploadUuid) parts.push("logo 已配置");
  return parts.length > 0 ? "品牌化（" + parts.join("，") + "）" : "内置配色";
}

function renderTemplateList(registry: DocTemplateRegistry): string {
  const templates = Object.values(registry.templates);
  const branded = templates.filter((template) => template.brand !== undefined);
  const lines: string[] = ["可用 Word 排版模板（共 " + templates.length + " 个）："];
  for (const template of templates) {
    const aliases = template.aliases.slice(0, 6).join("、");
    const aliasNote =
      aliases === ""
        ? ""
        : "；别名：" + aliases + (template.aliases.length > 6 ? " 等" : "");
    lines.push(
      "- " +
        template.id +
        "｜" +
        template.label +
        " — " +
        template.description +
        aliasNote +
        "；品牌：" +
        brandState(template),
    );
  }
  lines.push(
    "默认模板：work-report（未指定模板、也无法从标题或需求关键词推断时使用；id、别名或中文名称都可作为模板标识）。",
  );
  lines.push(
    branded.length > 0
      ? "品牌状态：已品牌化 " + branded.length + " 个模板（" + branded.map((template) => template.id).join("、") + "）。"
      : "品牌状态：未配置品牌模板（全部使用内置配色）。",
  );
  return lines.join("\n");
}

export function createOfficeListTemplatesTool(options: OfficeListTemplatesToolOptions = {}) {
  const registry = options.registry ?? DEFAULT_TEMPLATE_REGISTRY;
  return defineTool({
    name: "office_list_templates",
    description:
      "列出生成 Word 文档时可选的排版模板：id、名称、适用场景说明、别名与品牌状态（是否为部署品牌配色）。" +
      "当用户要写 Word/报告/论文/简历/公文，但没明确指定版式，或你拿不准该用哪个模板时，先调用本工具，再把选中的 id 或别名作为文档生成的模板参数传给 office_export。" +
      "不要编造不存在的模板 id；用户已明确指定模板时无需调用。",
    inputSchema: z.object({}),
    async execute() {
      return renderTemplateList(registry);
    },
  });
}
