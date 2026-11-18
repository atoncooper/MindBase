import { randomUUID } from "node:crypto";
import {
  type AcademicDocument,
  type AcademicDocumentRepository,
  type AcademicProject,
  type AcademicSection,
} from "../../repository/academic.js";
import type {
  DocumentRevision,
  ResearchDocumentRevisionRepository,
} from "../../repository/research-document-revisions.js";
import { AcademicError } from "./academic.js";

// 类型仍以 repository 契约为权威；此处再导出，兼容从服务模块导入版本的调用方。
export type { DocumentRevision } from "../../repository/research-document-revisions.js";

/** 项目标识：服务方法同时接受项目对象或项目 id，内部统一按 id 使用。 */
export type DocumentProjectRef = Pick<AcademicProject, "id"> | string;

/** 快照原因上限（与工具 schema 一致）。 */
const MAX_REASON = 200;
/** 单个章节 diff 里保留的示例行数上限（行数统计始终按全量计算）。 */
const MAX_DIFF_LINES_PER_SECTION = 100;
/** 有界 LCS 的单元格上限；超过后退化为“全部新增/删除”，避免大章节卡死。 */
const MAX_LCS_CELLS = 250_000;

export interface DocumentVersionServiceDeps {
  revisions: ResearchDocumentRevisionRepository;
  documents: AcademicDocumentRepository;
}

export type DocumentSectionDiffStatus = "added" | "removed" | "changed" | "unchanged";

/** 一节（按 section.key 对齐）在两个版本之间的差异。 */
export interface DocumentSectionDiff {
  key: string;
  fromTitle?: string;
  toTitle?: string;
  status: DocumentSectionDiffStatus;
  addedLines: number;
  removedLines: number;
  /** 新增内容行（最多 MAX_DIFF_LINES_PER_SECTION 行） */
  added: string[];
  /** 删除内容行（最多 MAX_DIFF_LINES_PER_SECTION 行） */
  removed: string[];
}

export interface DocumentVersionDiff {
  documentId: string;
  projectId: string;
  from: { version: number; title: string; createdAt: number };
  /** to.current=true 表示与尚未快照的当前文档比较（此时没有 version） */
  to: { version?: number; title: string; current: boolean };
  sections: DocumentSectionDiff[];
  /** 一行中文摘要（变更节数 + 新增/删除行数） */
  summary: string;
  addedLines: number;
  removedLines: number;
}

export interface DocumentRestoreResult {
  document: AcademicDocument;
  /** 回滚前当前状态自动生成的新版本 */
  snapshot: DocumentRevision;
  /** 恢复到的历史版本 */
  restoredFrom: DocumentRevision;
}

/**
 * 文档版本服务：为写作文档生成快照、列出历史版本、按章节对比版本差异并把
 * 文档回滚到指定版本。
 *
 * 回滚语义：先把“当前状态”快照成新版本（因此任何回滚都可再次回滚），再用
 * 目标版本的章节覆盖当前章节，并删除目标版本中不存在的章节。历史快照永不
 * 修改。所有方法先做 uid + projectId 归属校验，越权按 404 处理。
 */
export class DocumentVersionService {
  constructor(private readonly deps: DocumentVersionServiceDeps) {}

  /** 为文档当前状态生成快照；version = 该文档现有最大 version + 1（无历史时为 1）。 */
  async snapshot(
    uid: string,
    project: DocumentProjectRef,
    document: AcademicDocument,
    reason?: string,
  ): Promise<DocumentRevision> {
    const projectId = projectIdOf(project);
    if (typeof uid !== "string" || uid.trim() === "") throw new AcademicError(401, "缺少用户身份");
    if (!document || document.uid !== uid || document.projectId !== projectId) {
      throw new AcademicError(404, "文档不存在或无权访问");
    }
    const note = normalizeReason(reason);
    const latest = await this.deps.revisions.latest(uid, document.id);
    const revision: DocumentRevision = {
      id: randomUUID(),
      uid,
      projectId,
      documentId: document.id,
      version: (latest?.version ?? 0) + 1,
      title: document.title,
      sections: structuredClone(document.sections),
      ...(note !== undefined ? { reason: note } : {}),
      createdAt: Date.now(),
    };
    await this.deps.revisions.create(revision);
    return revision;
  }

  /** 文档的历史版本，按 version 升序（旧 → 新）。 */
  async list(uid: string, project: DocumentProjectRef, documentId: string): Promise<DocumentRevision[]> {
    const projectId = projectIdOf(project);
    const document = await this.requireDocument(uid, projectId, documentId);
    return this.deps.revisions.listByDocument(uid, document.projectId, document.id);
  }

  /**
   * 对比两个版本：toVersion 省略时与当前文档比较。章节按 key 对齐，逐行计算
   * 新增/删除行数；只统计、不改文档。
   */
  async diff(
    uid: string,
    project: DocumentProjectRef,
    documentId: string,
    fromVersion: number,
    toVersion?: number,
  ): Promise<DocumentVersionDiff> {
    const projectId = projectIdOf(project);
    const document = await this.requireDocument(uid, projectId, documentId);
    const revisions = await this.deps.revisions.listByDocument(uid, document.projectId, document.id);

    const from = findVersion(revisions, fromVersion);
    if (!from) throw new AcademicError(404, "版本 v" + fromVersion + " 不存在");
    let toSections: ReadonlyArray<AcademicSection>;
    let toTitle: string;
    let toVersionValue: number | undefined;
    let current: boolean;
    if (toVersion !== undefined) {
      const to = findVersion(revisions, toVersion);
      if (!to) throw new AcademicError(404, "版本 v" + toVersion + " 不存在");
      toSections = to.sections;
      toTitle = to.title;
      toVersionValue = to.version;
      current = false;
    } else {
      toSections = document.sections;
      toTitle = document.title;
      current = true;
    }

    const sections = diffSections(from.sections, toSections);
    let addedLines = 0;
    let removedLines = 0;
    for (const section of sections) {
      addedLines += section.addedLines;
      removedLines += section.removedLines;
    }
    return {
      documentId: document.id,
      projectId: document.projectId,
      from: { version: from.version, title: from.title, createdAt: from.createdAt },
      to: { ...(toVersionValue !== undefined ? { version: toVersionValue } : {}), title: toTitle, current },
      sections,
      summary: summarizeDiff(from.version, toVersionValue, current, sections, addedLines, removedLines),
      addedLines,
      removedLines,
    };
  }

  /**
   * 回滚到指定历史版本：先把当前状态快照成新版本，再用旧版本的章节覆盖当前
   * 章节（目标版本没有的章节会被删除）。返回恢复后的文档与两个版本记录。
   */
  async restore(
    uid: string,
    project: DocumentProjectRef,
    documentId: string,
    version: number,
  ): Promise<DocumentRestoreResult> {
    const projectId = projectIdOf(project);
    const document = await this.requireDocument(uid, projectId, documentId);
    const revisions = await this.deps.revisions.listByDocument(uid, document.projectId, document.id);
    const target = findVersion(revisions, version);
    if (!target) throw new AcademicError(404, "版本 v" + version + " 不存在");

    // 回滚前先给当前状态留一份快照，保证回滚本身也可撤销。
    const snapshot = await this.snapshot(uid, projectId, document, "回滚前自动快照（恢复到 v" + version + "）");

    const targetKeys = new Set(target.sections.map((section) => section.key));
    for (const section of sortSections(target.sections)) {
      await this.deps.documents.upsertSection(uid, document.id, {
        key: section.key,
        title: section.title,
        content: section.content,
        order: section.order,
      });
    }
    // 目标版本没有的章节属于“后加内容”，回滚时要一并移除，否则状态与旧版本不一致。
    for (const section of document.sections) {
      if (!targetKeys.has(section.key)) {
        await this.deps.documents.deleteSection(uid, document.id, section.key);
      }
    }
    const restored = await this.deps.documents.getDocument(uid, document.id);
    if (!restored) throw new AcademicError(404, "文档不存在或无权访问");
    return { document: restored, snapshot, restoredFrom: target };
  }

  private async requireDocument(uid: string, projectId: string, documentId: string): Promise<AcademicDocument> {
    if (typeof uid !== "string" || uid.trim() === "") throw new AcademicError(401, "缺少用户身份");
    if (typeof documentId !== "string" || documentId.trim() === "") {
      throw new AcademicError(400, "缺少 documentId");
    }
    const document = await this.deps.documents.getDocument(uid, documentId);
    if (!document || document.projectId !== projectId) {
      throw new AcademicError(404, "文档不存在或无权访问");
    }
    return document;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function projectIdOf(project: DocumentProjectRef): string {
  const id = typeof project === "string" ? project : project?.id;
  if (typeof id !== "string" || id.trim() === "") throw new AcademicError(400, "缺少 projectId");
  return id;
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason !== "string") throw new AcademicError(400, "reason 必须是字符串");
  const trimmed = reason.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_REASON) throw new AcademicError(400, "reason 过长（上限 " + MAX_REASON + " 字符）");
  return trimmed;
}

function findVersion(revisions: ReadonlyArray<DocumentRevision>, version: number): DocumentRevision | undefined {
  if (!Number.isInteger(version) || version < 1) throw new AcademicError(400, "版本号必须是正整数");
  return revisions.find((revision) => revision.version === version);
}

function sortSections(sections: ReadonlyArray<AcademicSection>): AcademicSection[] {
  return [...sections].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

/** 按 section.key 对齐两边章节，逐节计算行级差异。 */
function diffSections(from: ReadonlyArray<AcademicSection>, to: ReadonlyArray<AcademicSection>): DocumentSectionDiff[] {
  const fromMap = new Map(sortSections(from).map((section) => [section.key, section] as const));
  const toMap = new Map(sortSections(to).map((section) => [section.key, section] as const));
  const keys: string[] = [];
  for (const section of sortSections(from)) keys.push(section.key);
  for (const section of sortSections(to)) if (!fromMap.has(section.key)) keys.push(section.key);

  return keys.map((key) => {
    const before = fromMap.get(key);
    const after = toMap.get(key);
    if (before && !after) {
      const removed = splitContentLines(before.content);
      return {
        key,
        fromTitle: before.title,
        status: "removed",
        addedLines: 0,
        removedLines: removed.length,
        added: [],
        removed: removed.slice(0, MAX_DIFF_LINES_PER_SECTION),
      };
    }
    if (!before && after) {
      const added = splitContentLines(after.content);
      return {
        key,
        toTitle: after.title,
        status: "added",
        addedLines: added.length,
        removedLines: 0,
        added: added.slice(0, MAX_DIFF_LINES_PER_SECTION),
        removed: [],
      };
    }
    if (!before || !after) {
      return { key, status: "unchanged", addedLines: 0, removedLines: 0, added: [], removed: [] };
    }
    const lines = diffContentLines(before.content, after.content);
    const changed = lines.added.length > 0 || lines.removed.length > 0 || before.title !== after.title;
    return {
      key,
      fromTitle: before.title,
      toTitle: after.title,
      status: changed ? "changed" : "unchanged",
      addedLines: lines.added.length,
      removedLines: lines.removed.length,
      added: lines.added.slice(0, MAX_DIFF_LINES_PER_SECTION),
      removed: lines.removed.slice(0, MAX_DIFF_LINES_PER_SECTION),
    };
  });
}

function summarizeDiff(
  fromVersion: number,
  toVersion: number | undefined,
  current: boolean,
  sections: ReadonlyArray<DocumentSectionDiff>,
  addedLines: number,
  removedLines: number,
): string {
  const changed = sections.filter((section) => section.status !== "unchanged");
  if (changed.length === 0) return "v" + fromVersion + " 与" + (current ? "当前文档" : " v" + toVersion) + "内容一致。";
  const added = changed.filter((section) => section.status === "added").length;
  const removed = changed.filter((section) => section.status === "removed").length;
  const modified = changed.length - added - removed;
  const parts: string[] = [];
  if (modified > 0) parts.push("修改 " + modified + " 节");
  if (added > 0) parts.push("新增 " + added + " 节");
  if (removed > 0) parts.push("删除 " + removed + " 节");
  const target = current ? "当前文档" : "v" + toVersion;
  return (
    "v" + fromVersion + " → " + target + "：" + parts.join("、") + "，共新增 " + addedLines + " 行、删除 " + removedLines + " 行。"
  );
}

/** Split content into lines: empty text is 0 lines, a trailing newline is not a line. */
function splitContentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff: trim the common prefix/suffix, then run a bounded LCS on the rest.
 * Oversized middles degrade to "all removed + all added" instead of hanging.
 */
function diffContentLines(before: string, after: string): { added: string[]; removed: string[] } {
  const left = splitContentLines(before);
  const right = splitContentLines(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const midLeft = left.slice(start, endLeft);
  const midRight = right.slice(start, endRight);
  if (midLeft.length === 0) return { added: midRight, removed: [] };
  if (midRight.length === 0) return { added: [], removed: midLeft };
  if (midLeft.length * midRight.length > MAX_LCS_CELLS) {
    return { added: midRight, removed: midLeft };
  }

  const cols = midRight.length + 1;
  const lcs = new Uint16Array((midLeft.length + 1) * cols);
  for (let i = 1; i <= midLeft.length; i += 1) {
    for (let j = 1; j <= midRight.length; j += 1) {
      lcs[i * cols + j] =
        midLeft[i - 1] === midRight[j - 1]
          ? lcs[(i - 1) * cols + (j - 1)] + 1
          : Math.max(lcs[(i - 1) * cols + j], lcs[i * cols + (j - 1)]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = midLeft.length;
  let j = midRight.length;
  while (i > 0 && j > 0) {
    if (midLeft[i - 1] === midRight[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      removed.push(midLeft[i - 1]);
      i -= 1;
    } else {
      added.push(midRight[j - 1]);
      j -= 1;
    }
  }
  while (i > 0) {
    removed.push(midLeft[i - 1]);
    i -= 1;
  }
  while (j > 0) {
    added.push(midRight[j - 1]);
    j -= 1;
  }
  removed.reverse();
  added.reverse();
  return { added, removed };
}
