/**
 * 「最近动态」展示层纯函数：事件合并 / 中文描述 / 操作者文案。
 *
 * 事件 payload 是后端写入的 JSON 字符串，历史数据可能只有 "{}"（旧版本事件），
 * 所以所有字段读取都必须容错：解析失败或字段缺失时降级为空字符串，绝不抛错。
 */

import {
  MANUSCRIPT_DOCUMENT_KIND_LABELS,
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  type ResearchEvent,
} from "../../lib/research";

/** 操作者文案：user→「我」、agent→「AI 助手」、chat→「主对话」，其余原样。 */
export function actorLabel(actor: string): string {
  switch (actor) {
    case "user":
      return "我";
    case "agent":
      return "AI 助手";
    case "chat":
      return "主对话";
    default:
      return actor;
  }
}

/** 合并后的一行动态。 */
export interface ActivityItem {
  /** React key：取该组首条事件的 id。 */
  key: string;
  /** 该组首条事件（标题 / 详情 / 时间以它为准）。 */
  event: ResearchEvent;
  /** 该行代表的连续相同事件条数（≥1，含后端折叠的 repeat）。 */
  count: number;
}

/**
 * 一条事件自带的折叠条数。
 *
 * 后端已在服务端折叠连续相同事件（repeat ≥ 1）；旧后端 / 脏数据没有 repeat 时按 1 条处理。
 */
function eventRepeat(event: ResearchEvent): number {
  return Number.isFinite(event.repeat) ? Math.max(1, event.repeat) : 1;
}

/**
 * 把「连续且 kind + actor + payloadJson 完全相同」的事件合并成一条。
 *
 * 后端已做服务端折叠（每条事件带 repeat），这里再兜一层：若分页边界等处仍有
 * 连续相同事件，条数按各自 repeat 累加。历史库里 stage.updated 的 payload 全是
 * "{}"，连续几十条会被折叠成一行并标 ×N。
 */
export function mergeEvents(events: ResearchEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const event of events) {
    const last = items[items.length - 1];
    if (
      last !== undefined &&
      last.event.kind === event.kind &&
      last.event.actor === event.actor &&
      last.event.payloadJson === event.payloadJson
    ) {
      items[items.length - 1] = { ...last, count: last.count + eventRepeat(event) };
      continue;
    }
    items.push({ key: String(event.id), event, count: eventRepeat(event) });
  }
  return items;
}

type Payload = Record<string, unknown>;

/** 解析 payload JSON；非对象 / 解析失败一律返回 null。 */
function parsePayload(payloadJson: string): Payload | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Payload;
  } catch {
    return null;
  }
}

/** 读取字符串字段（去首尾空白）；缺失 / 类型不符返回空字符串。 */
function textField(payload: Payload | null, key: string): string {
  if (payload === null) return "";
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 读取数字字段；缺失 / 非有限数字返回 null。 */
function numberField(payload: Payload | null, key: string): number | null {
  if (payload === null) return null;
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读取字符串数组字段；缺失 / 类型不符返回空数组。 */
function stringArrayField(payload: Payload | null, key: string): string[] {
  if (payload === null) return [];
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** project.updated payload.changed 里的字段 key → 中文名。 */
const PROJECT_UPDATE_FIELD_LABELS: Record<string, string> = {
  title: "标题",
  paperKind: "论文类型",
  field: "研究领域",
  language: "语言",
  targetVenue: "目标期刊",
  privacy: "数据边界",
  deadline: "截止日期",
  metaJson: "元信息",
};

/** literature.verified payload.status → 中文文案。 */
const LITERATURE_VERIFY_LABELS: Record<string, string> = {
  verified: "已核实",
  missing: "查无此文",
  unverified: "待核验",
};

/**
 * 把一条事件翻译成「中文标题 + 详情」。
 *
 * 缺字段 / 旧 payload（"{}"）时详情降级为空字符串，标题退化为不带参的通用文案；
 * 解析过程中任何异常都兜底为原始 kind，保证动态列表永远能渲染。
 */
export function describeEvent(event: ResearchEvent): { title: string; detail: string } {
  try {
    const payload = parsePayload(event.payloadJson);
    switch (event.kind) {
      case "project.created": {
        return { title: "创建项目", detail: textField(payload, "title") };
      }
      case "project.updated": {
        const labels = stringArrayField(payload, "changed").map(
          (key) => PROJECT_UPDATE_FIELD_LABELS[key] ?? key,
        );
        return {
          title: "更新项目信息",
          detail: labels.length === 0 ? "" : "修改：" + labels.join("、"),
        };
      }
      case "stage.updated": {
        const stage = textField(payload, "stage");
        const from = textField(payload, "from");
        const to = textField(payload, "to");
        const fromLabel = from === "" ? "" : STAGE_STATUS_LABELS[from] ?? from;
        const toLabel = to === "" ? "" : STAGE_STATUS_LABELS[to] ?? to;
        let detail = "";
        if (fromLabel !== "" && toLabel !== "") detail = fromLabel + " → " + toLabel;
        else if (fromLabel !== "") detail = fromLabel;
        else if (toLabel !== "") detail = toLabel;
        return {
          title: stage === "" ? "阶段更新" : "阶段流转 · " + (STAGE_LABELS[stage] ?? stage),
          detail,
        };
      }
      case "artifact.added": {
        const name = textField(payload, "title");
        const stage = textField(payload, "stage");
        const kind = textField(payload, "kind");
        const parts: string[] = [];
        if (stage !== "") parts.push(STAGE_LABELS[stage] ?? stage);
        if (kind !== "") parts.push(kind);
        return {
          title: name === "" ? "登记产物" : "登记产物 · " + name,
          detail: parts.join(" · "),
        };
      }
      case "literature.imported": {
        const imported = numberField(payload, "imported");
        const skipped = numberField(payload, "skipped");
        const failed = numberField(payload, "failed");
        const parts: string[] = [];
        if (skipped !== null && skipped > 0) parts.push("跳过 " + skipped);
        if (failed !== null && failed > 0) parts.push("失败 " + failed);
        return {
          title: imported === null ? "导入文献" : "导入文献 " + imported + " 条",
          detail: parts.join(" · "),
        };
      }
      case "literature.verified": {
        const status = textField(payload, "status");
        return {
          title: "核验文献",
          detail: status === "" ? "" : LITERATURE_VERIFY_LABELS[status] ?? status,
        };
      }
      case "literature.deleted":
        return { title: "删除文献", detail: "" };
      case "literature.downloaded": {
        const bytes = numberField(payload, "bytes");
        return {
          title: "下载文献 PDF",
          detail: bytes === null ? "" : Math.round(bytes / 1024) + " KB",
        };
      }
      case "dataset.imported": {
        const name = textField(payload, "name");
        const rows = numberField(payload, "rows");
        const cols = numberField(payload, "cols");
        return {
          title: name === "" ? "导入数据集" : "导入数据集 · " + name,
          detail: rows !== null && cols !== null ? rows + " 行 × " + cols + " 列" : "",
        };
      }
      case "analysis.run": {
        const exitCode = numberField(payload, "exitCode");
        return {
          title: "运行分析脚本",
          detail: exitCode === null ? "" : "退出码 " + exitCode,
        };
      }
      case "ai.advice": {
        const chars = numberField(payload, "chars");
        return {
          title: "AI 保存阶段建议",
          detail: chars === null ? "" : chars + " 字",
        };
      }
      case "code.written": {
        const path = textField(payload, "path");
        const bytes = numberField(payload, "bytes");
        let detail = "";
        if (bytes !== null) detail = bytes < 1024 ? bytes + " 字节" : Math.round(bytes / 1024) + " KB";
        return { title: path === "" ? "写入代码" : "写入代码 · " + path, detail };
      }
      case "manuscript.document_created": {
        const title = textField(payload, "title");
        const kind = textField(payload, "kind");
        return {
          title: title === "" ? "新建文档" : "新建文档 · " + title,
          detail: kind === "" ? "" : MANUSCRIPT_DOCUMENT_KIND_LABELS[kind] ?? kind,
        };
      }
      case "plan.generated": {
        const stage = textField(payload, "stage");
        return {
          title: "AI 生成阶段计划",
          detail: stage === "" ? "" : STAGE_LABELS[stage] ?? stage,
        };
      }
      case "venue.recommended": {
        const count = numberField(payload, "count");
        return {
          title: "AI 推荐期刊",
          detail: count === null ? "" : count + " 个候选",
        };
      }
      case "plan.task": {
        const stage = textField(payload, "stage");
        const done = payload?.["done"];
        const result = done === true ? "已完成" : done === false ? "取消完成" : "";
        const stageLabel = stage === "" ? "" : STAGE_LABELS[stage] ?? stage;
        const detail = stageLabel === "" ? result : result === "" ? stageLabel : stageLabel + " · " + result;
        return { title: "计划任务更新", detail };
      }
      default:
        return { title: event.kind, detail: "" };
    }
  } catch {
    return { title: event.kind, detail: "" };
  }
}
