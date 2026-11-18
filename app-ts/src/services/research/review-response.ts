import { createLogger } from "../../logger.js";
import type {
  AcademicActor,
  AcademicDocument,
  AcademicDocumentKind,
  AcademicDocumentRepository,
  AcademicEventRepository,
} from "../../repository/academic.js";
import { AcademicError } from "./academic.js";

const log = createLogger("REVIEW-RESPONSE");

/** 一次生成的审稿回复信最多覆盖的意见条数。 */
export const REVIEW_RESPONSE_MAX_ITEMS = 30;
/** 固定章节 key（与 manuscript-templates 的 response_letter 大纲一致）。 */
export const REVIEW_RESPONSE_SECTION_KEYS = ["comments", "responses", "changes"] as const;
/** 固定章节标题：审稿意见汇总 / 逐条回复 / 修改清单。 */
export const REVIEW_RESPONSE_SECTION_TITLES = ["审稿意见汇总", "逐条回复", "修改清单"] as const;

const MAX_COMMENT = 5_000;
const MAX_RESPONSE = 10_000;
const MAX_CHANGE = 5_000;

/** 单条审稿意见及作者回复（全部来自用户/调用方入参）。 */
export interface ReviewResponseItem {
  /** 审稿意见原文 */
  comment: string;
  /** 针对该条意见的回复 */
  response: string;
  /** 对应的修改说明（可选） */
  change?: string;
}

/** 回复信章节，key 稳定，可直接作为写作文档章节使用。 */
export interface ReviewResponseSection {
  key: string;
  title: string;
  content: string;
}

export interface ReviewResponseLetter {
  title: string;
  sections: ReviewResponseSection[];
}

/**
 * 由入参构造审稿回复信：标题 + 固定三章（审稿意见汇总/逐条回复/修改清单）。
 * 只重排/编号入参内容，不生成、不补全任何审稿意见或修改说明。
 */
export function buildResponseLetter(documentTitle: string, items: ReviewResponseItem[]): ReviewResponseLetter {
  const title = typeof documentTitle === "string" ? documentTitle.trim() : "";
  const normalized = normalizeItems(items);

  const comments = normalized
    .map((item, index) => index + 1 + ". " + item.comment)
    .join("\n");
  const responses = normalized
    .map((item, index) => "**意见 " + (index + 1) + "**：" + item.comment + "\n\n**回复**：" + item.response)
    .join("\n\n");
  const changes = normalized
    .map((item, index) => (item.change ? index + 1 + ". " + item.change : ""))
    .filter((line) => line !== "")
    .join("\n");

  return {
    title: "审稿回复信：" + (title || "未命名稿件"),
    sections: [
      { key: "comments", title: "审稿意见汇总", content: comments },
      { key: "responses", title: "逐条回复", content: responses },
      {
        key: "changes",
        title: "修改清单",
        content:
          changes !== ""
            ? changes
            : "（本次回复未提供具体修改说明；如已修改，请在逐条回复中注明对应章节。）",
      },
    ],
  };
}

function normalizeItems(items: ReviewResponseItem[]): ReviewResponseItem[] {
  if (!Array.isArray(items)) throw new AcademicError(400, "items 必须是数组");
  if (items.length === 0) throw new AcademicError(400, "至少需要一条审稿意见（comment + response）");
  if (items.length > REVIEW_RESPONSE_MAX_ITEMS) {
    throw new AcademicError(400, "审稿意见最多 " + REVIEW_RESPONSE_MAX_ITEMS + " 条");
  }
  return items.map((item, index) => {
    const label = "第 " + (index + 1) + " 条意见";
    const comment = requiredText(item?.comment, label + "的 comment", MAX_COMMENT);
    const response = requiredText(item.response, label + "的 response", MAX_RESPONSE);
    const change = optionalText(item.change, label + "的 change", MAX_CHANGE);
    return { comment, response, ...(change !== undefined ? { change } : {}) };
  });
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AcademicError(400, field + " 不能为空");
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AcademicError(400, field + " 过长（上限 " + max + " 字符）");
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AcademicError(400, field + " 必须是字符串");
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > max) throw new AcademicError(400, field + " 过长（上限 " + max + " 字符）");
  return trimmed;
}

export interface ReviewResponseServiceDeps {
  documents: Pick<AcademicDocumentRepository, "createDocument">;
  /** Optional project event feed; a failed append never fails the creation. */
  events?: Pick<AcademicEventRepository, "append">;
}

export interface CreateReviewResponseInput {
  /** 原稿标题（用于回复信标题），空时使用“未命名稿件” */
  documentTitle: string;
  items: ReviewResponseItem[];
  /** 文档类型，默认 revision（修改稿） */
  kind?: AcademicDocumentKind;
  /** Event provenance: agent tool vs REST user action. */
  actor?: AcademicActor;
}

export interface ReviewResponseCreation {
  document: AcademicDocument;
  letter: ReviewResponseLetter;
}

/**
 * Persist a review-response letter as a manuscript document. The letter content
 * comes exclusively from the provided items (buildResponseLetter); no model is
 * called and no missing text is invented.
 */
export class ReviewResponseService {
  constructor(private readonly deps: ReviewResponseServiceDeps) {}

  async create(uid: string, projectId: string, input: CreateReviewResponseInput): Promise<ReviewResponseCreation> {
    if (typeof uid !== "string" || uid.trim() === "") throw new AcademicError(401, "缺少用户身份");
    if (typeof projectId !== "string" || projectId.trim() === "") throw new AcademicError(400, "缺少 projectId");
    const letter = buildResponseLetter(input?.documentTitle ?? "", input?.items);
    const document = await this.deps.documents.createDocument(uid, projectId, {
      kind: input.kind ?? "revision",
      title: letter.title,
      sections: letter.sections.map((section, index) => ({
        key: section.key,
        title: section.title,
        content: section.content,
        order: index,
      })),
    });
    try {
      await this.deps.events?.append(
        uid,
        projectId,
        "manuscript.review_response_created",
        { documentId: document.id, title: document.title, itemCount: letter.sections.length > 0 ? input.items.length : 0 },
        input.actor ?? "user",
      );
    } catch (err) {
      log.warn(
        "[REVIEW-RESPONSE] event append failed document_id=" +
          document.id +
          ": " +
          (err instanceof Error ? err.message : err),
      );
    }
    return { document, letter };
  }
}
