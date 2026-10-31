/**
 * Typed access to the research-project commands (Phase 0 skeleton).
 *
 * A project owns a six-stage lifecycle (topic → design → advise → experiment →
 * writing → submission), artifacts and an append-only event log. Journal-first:
 * the default paper kind is "journal".
 */

import { invoke } from "@tauri-apps/api/core";

/** Canonical stage order shared with the Rust side. */
export const RESEARCH_STAGES = [
  "topic",
  "design",
  "advise",
  "experiment",
  "writing",
  "submission",
] as const;

export type ResearchStageId = (typeof RESEARCH_STAGES)[number];

export type StageStatus = "locked" | "active" | "submitted" | "approved" | "frozen" | "rework";

export interface ResearchProject {
  id: string;
  title: string;
  paperKind: string;
  field: string;
  language: string;
  targetVenue: string;
  currentStage: ResearchStageId | string;
  privacy: string;
  deadline: string;
  metaJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchStage {
  stage: ResearchStageId | string;
  label: string;
  status: StageStatus | string;
  enteredAt: number | null;
  approvedAt: number | null;
  gateJson: string;
}

export interface ResearchArtifact {
  id: string;
  stage: string;
  kind: string;
  title: string;
  path: string;
  version: number;
  status: string;
  createdAt: number;
}

export interface ProjectDetail {
  project: ResearchProject;
  stages: ResearchStage[];
  artifacts: ResearchArtifact[];
}

export interface ResearchEvent {
  id: number;
  ts: number;
  actor: string;
  kind: string;
  payloadJson: string;
}

export interface ProjectCreateInput {
  title: string;
  paperKind?: string;
  field?: string;
  language?: string;
  targetVenue?: string;
  privacy?: string;
  deadline?: string;
}

export interface ProjectUpdateInput {
  title?: string;
  paperKind?: string;
  field?: string;
  language?: string;
  targetVenue?: string;
  privacy?: string;
  deadline?: string;
  metaJson?: string;
}

export function listResearchProjects(): Promise<ResearchProject[]> {
  return invoke<ResearchProject[]>("research_projects_list");
}

export function createResearchProject(input: ProjectCreateInput): Promise<ProjectDetail> {
  return invoke<ProjectDetail>("research_project_create", { input });
}

export function getResearchProject(projectId: string): Promise<ProjectDetail> {
  return invoke<ProjectDetail>("research_project_get", { projectId });
}

export function updateResearchProject(
  projectId: string,
  input: ProjectUpdateInput,
): Promise<ResearchProject> {
  return invoke<ResearchProject>("research_project_update", { projectId, input });
}

export function updateResearchStage(
  projectId: string,
  stage: string,
  status: StageStatus,
  gateJson?: string,
): Promise<ProjectDetail> {
  return invoke<ProjectDetail>("research_stage_update", {
    projectId,
    stage,
    status,
    gateJson: gateJson ?? null,
  });
}

export function addResearchArtifact(
  projectId: string,
  args: { stage?: string; kind?: string; title: string; path?: string },
): Promise<ProjectDetail> {
  return invoke<ProjectDetail>("research_artifact_add", {
    projectId,
    stage: args.stage ?? null,
    kind: args.kind ?? null,
    title: args.title,
    path: args.path ?? null,
  });
}

export function listResearchEvents(projectId: string, limit = 20): Promise<ResearchEvent[]> {
  return invoke<ResearchEvent[]>("research_events_list", { projectId, limit });
}

/** Display labels for the six stages (kept next to the ids). */
export const STAGE_LABELS: Record<string, string> = {
  topic: "选题",
  design: "研究设计",
  advise: "指导",
  experiment: "实验",
  writing: "写作",
  submission: "投稿",
};

/** Display labels for paper kinds. */
export const PAPER_KIND_LABELS: Record<string, string> = {
  journal: "期刊论文",
  conference: "会议论文",
  thesis_master: "硕士学位论文",
  thesis_phd: "博士学位论文",
  course: "课程论文",
  grant: "基金申报书",
};

// ---------------------------------------------------------------------------
// Phase 1 · 证据层：文献导入 / Crossref 核验 / BibTeX 导出
// ---------------------------------------------------------------------------

/** 文献核验状态：待核验 / Crossref 已核实 / Crossref 查无此文。 */
export type LiteratureStatus = "unverified" | "verified" | "missing";

/** 一条文献引用（literature_refs 行，字段与 Rust DTO 一一对应）。 */
export interface LiteratureRef {
  id: string;
  /** 唯一引用键（BibTeX cite key / CSL id），同一项目内唯一。 */
  citeKey: string;
  doi: string;
  title: string;
  /** 作者 JSON 数组文本，如 '["张三","Li Si"]'；展示前用 parseAuthors 解析。 */
  authorsJson: string;
  year: number | null;
  venue: string;
  /** CSL 类型，如 article-journal / paper-conference / book / thesis / document。 */
  type: string;
  url: string;
  status: LiteratureStatus | string;
  note: string;
}

/** `literature_import` 的返回（计数 + 本次新写入的行 + 逐条失败原因）。 */
export interface LiteratureImportResult {
  /** 本次新写入的条数。 */
  imported: number;
  /** 因 citeKey 重复被跳过的条数。 */
  skipped: number;
  /** 无法解析的条目数。 */
  failed: number;
  /** 仅本次新写入的行（已含 status='unverified'）。 */
  refs: LiteratureRef[];
  /** 逐条中文失败原因；成功时为空数组。 */
  errors: string[];
}

/** 粘贴文本的格式。前端只在用户显式选择时才覆盖自动识别结果。 */
export type LiteratureFormat = "bibtex" | "csl";

/** 列出项目下的全部文献引用。 */
export function listLiterature(projectId: string): Promise<LiteratureRef[]> {
  return invoke<LiteratureRef[]>("literature_list", { projectId });
}

/** 导入用户粘贴的 BibTeX / CSL-JSON 原文。 */
export function importLiterature(
  projectId: string,
  format: LiteratureFormat,
  content: string,
): Promise<LiteratureImportResult> {
  return invoke<LiteratureImportResult>("literature_import", { projectId, format, content });
}

/**
 * 用 Crossref 核验单条文献。
 *
 * 404 / 无匹配不 reject，而是返回 status='missing' 的 ref；
 * 网络失败（超时等）才 reject，界面需要区分"查无此文"和"没网"。
 */
export function verifyLiterature(projectId: string, refId: string): Promise<LiteratureRef> {
  return invoke<LiteratureRef>("literature_verify", { projectId, refId });
}

/** 删除一条文献引用（不可恢复）。 */
export function deleteLiterature(projectId: string, refId: string): Promise<void> {
  return invoke<void>("literature_delete", { projectId, refId });
}

/** 导出项目全部文献为 BibTeX 全文（不落盘；空库返回空字符串）。 */
/** 文献 PDF 下载结果：本地路径 / 在线地址（非开放获取时）。 */
export interface LiteraturePdfDownload {
  path: string | null;
  url: string;
  message: string;
}

/** 下载文献 PDF；拿不到 PDF（订阅/登录页）时返回在线地址。 */
export function downloadLiteraturePdf(
  projectId: string,
  refId: string,
): Promise<LiteraturePdfDownload> {
  return invoke<LiteraturePdfDownload>("literature_download_pdf", { projectId, refId });
}

export function exportLiteratureBibtex(projectId: string): Promise<string> {
  return invoke<string>("literature_export_bibtex", { projectId });
}

/**
 * 解析 authorsJson 为字符串数组。
 *
 * 脏数据（非 JSON / 非字符串数组）一律返回空数组：展示层不能因为一行坏数据崩溃。
 */
export function parseAuthors(authorsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(authorsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 1 · 数据层：数据集导入 / 画像 / 分析脚本
// ---------------------------------------------------------------------------

/** 数据集画像里的一列（由 Python 脚本 dataset_profile.py 产出）。 */
export interface DatasetColumnProfile {
  name: string;
  type: string;
  missing: number;
  unique: number;
  min: number | string | null;
  max: number | string | null;
  mean: number | null;
}

/** dataset_profile.py 输出的 JSON；ok=false 时只有 error。 */
export interface DatasetProfile {
  ok: boolean;
  rows?: number;
  cols?: number;
  columns?: DatasetColumnProfile[];
  /** 前若干行原始预览（单元格可能是字符串 / 数字 / 空）。 */
  preview?: Array<Array<string | number | null>>;
  error?: string;
}

/** 一条数据集记录（datasets 行，字段与 Rust DTO 一一对应）。 */
export interface DatasetRow {
  id: string;
  name: string;
  /** 复制到 <data_dir>/research/<project>/data/original/ 后的路径。 */
  path: string;
  /** 文件内容摘要（当前实现用 MD5）。 */
  sha256: string;
  rows: number | null;
  cols: number | null;
  /** 数据边界，桌面端恒为本地。 */
  privacy: string;
  /** 列结构 JSON 字符串（画像是 profileJson，两者都需 JSON.parse）。 */
  schemaJson: string;
  /** Python 画像 JSON 原文。 */
  profileJson: string;
  createdAt: number;
}

/** `analysis_run` 的返回。 */
export interface AnalysisResult {
  stdout: string;
  stderr: string;
  /** 脚本退出码（非 0 也正常返回；超时 / 启动失败走 reject）。 */
  exitCode: number;
  /** 脚本落盘路径，便于用户手动再次运行。 */
  scriptPath: string;
}

/** 列出项目下已导入的数据集。 */
export function listDatasets(projectId: string): Promise<DatasetRow[]> {
  return invoke<DatasetRow[]>("dataset_list", { projectId });
}

/** 导入一个本地数据文件（CSV/XLSX）：复制进项目目录并生成画像。 */
export function importDataset(projectId: string, path: string): Promise<DatasetRow> {
  return invoke<DatasetRow>("dataset_import", { projectId, path });
}

/** 在项目目录下执行一段 Python 分析脚本，返回 stdout/stderr/退出码。 */
export function runAnalysis(
  projectId: string,
  name: string,
  script: string,
): Promise<AnalysisResult> {
  return invoke<AnalysisResult>("analysis_run", { projectId, name, script });
}

/**
 * 解析 profileJson。
 *
 * 解析失败或结构不符时返回 null（卡片退化为只显示文件信息），绝不抛错。
 */
export function parseDatasetProfile(profileJson: string): DatasetProfile | null {
  try {
    const parsed: unknown = JSON.parse(profileJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<DatasetProfile>;
    if (typeof candidate.ok !== "boolean") return null;
    return candidate as DatasetProfile;
  } catch {
    return null;
  }
}

/** 画像中所有列的缺失值总数；没有列信息时返回 null。 */
export function datasetMissingTotal(profile: DatasetProfile | null): number | null {
  if (profile === null || !Array.isArray(profile.columns)) return null;
  let total = 0;
  for (const column of profile.columns) {
    if (typeof column.missing === "number" && Number.isFinite(column.missing)) {
      total += column.missing;
    }
  }
  return total;
}

/** 单元格展示：null / undefined 显示为空，数字保留原样。 */
export function cellText(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

// ---------------------------------------------------------------------------
// Phase 1 · 研究 agent：阶段化 AI 指导
// ---------------------------------------------------------------------------

/** 传给 `research_ask` 的一轮对话（即 Rust 侧 ChatTurn）。 */
export interface ResearchChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 向研究 agent 提问（非流式）。
 *
 * `history` 只放"当前问题之前"的对话；Rust 侧会拼上项目简报、当前阶段提示词
 * 以及文献 / 数据摘要，再交给 agent 生成回答。
 */
export function askResearch(
  projectId: string,
  question: string,
  history?: ResearchChatTurn[],
): Promise<string> {
  return invoke<string>("research_ask", { projectId, question, history: history ?? null });
}

/** 控制台展示的最新 AI 阶段建议（Rust 侧 guidance_notes 最新一条）。 */
export interface ResearchAdvice {
  question: string;
  notes: string;
  createdAt: number;
}

/** 读取最新 AI 建议（控制台刷新时回填，避免每次都是静态文案）。 */
export function getLatestResearchAdvice(projectId: string): Promise<ResearchAdvice | null> {
  return invoke<ResearchAdvice | null>("research_advice_latest", { projectId });
}

/** 每个阶段的「下一步该做什么」提示（展示用静态文案，不参与推理）。 */
export const STAGE_ADVICE: Record<string, string> = {
  topic: "先把研究问题收敛成一句可证伪的陈述，再核对近三年同方向的文献缺口与目标期刊的选题偏好。",
  design: "明确研究设计（变量、对照、样本量、分析方法），并把可复现的实验步骤与数据需求写进研究设计产物。",
  advise: "带着已有设计去讨论：列出待确认的关键决策、请导师给取舍意见，并把结论沉淀为决策记录。",
  experiment: "先确认数据集画像（行数 / 列类型 / 缺失）再跑分析脚本；每次运行都保留脚本与结论，保证可复现。",
  writing: "按目标期刊的结构逐节推进；每个论断都要能回指到一条已核验文献或一次实验运行。",
  submission: "核对投稿清单（格式、图注、伦理声明、数据可用性），并记录投稿版本与审稿意见的对应关系。",
};

/** 下一个阶段；当前已是投稿阶段（或未知阶段）时返回 null。 */
export function nextStage(stage: string): ResearchStageId | null {
  const index = RESEARCH_STAGES.indexOf(stage as ResearchStageId);
  if (index < 0 || index >= RESEARCH_STAGES.length - 1) return null;
  return RESEARCH_STAGES[index + 1];
}

// ---------------------------------------------------------------------------
// Phase 1 · 写作层：论文章节编辑 / DOCX 导出
// ---------------------------------------------------------------------------

/** 默认章节顺序（与 Rust 侧 manuscript 默认结构一致）。 */
export const DEFAULT_MANUSCRIPT_SECTIONS = [
  "摘要",
  "1 引言",
  "2 相关工作",
  "3 方法",
  "4 实验",
  "5 讨论",
  "6 结论",
  "参考文献",
] as const;

export type ManuscriptSectionName = (typeof DEFAULT_MANUSCRIPT_SECTIONS)[number];

/** 一个论文章节（manuscript_sections 行，字段与 Rust DTO 一致）。 */
export interface ManuscriptSection {
  id: string;
  /** 章节名，如「摘要」「1 引言」。 */
  section: string;
  /** 章节顺序（默认顺序的下标）。 */
  ord: number;
  /** 章节 Markdown 文件的绝对路径。 */
  path: string;
  /** 后端统计的字数。 */
  words: number;
  /** 状态，默认 draft。 */
  status: string;
  updatedAt: number;
  /**
   * 章节正文（Markdown）。
   *
   * manuscript_list 会读取 sections/*.md 一并返回（读不到时为空字符串），
   * 编辑器直接用它回显；manuscript_save 的返回值同样带 content。
   */
  content: string;
}

/** `export_docx` 的返回：导出的 DOCX 路径与章节 / 字数统计。 */
export interface DocxExport {
  /** 导出的 .docx 绝对路径。 */
  path: string;
  /** 本次合并的章节数。 */
  sections: number;
  /** 全文总字数。 */
  words: number;
}

/** 列出项目的论文章节（不存在的章节后端不会返回）。 */
export function listManuscript(projectId: string): Promise<ManuscriptSection[]> {
  return invoke<ManuscriptSection[]>("manuscript_list", { projectId });
}

/** 保存一个章节正文（后端按章节名落盘 Markdown 并统计字数）。 */
export function saveManuscript(
  projectId: string,
  section: string,
  content: string,
): Promise<ManuscriptSection> {
  return invoke<ManuscriptSection>("manuscript_save", { projectId, section, content });
}

/** 删除一个章节（不可恢复）。 */
export function deleteManuscript(projectId: string, section: string): Promise<void> {
  return invoke<void>("manuscript_delete", { projectId, section });
}

/** 把全部已保存章节合并导出为 DOCX。 */
export function exportDocx(projectId: string): Promise<DocxExport> {
  return invoke<DocxExport>("export_docx", { projectId });
}
