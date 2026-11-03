import type { PromptRegistry } from "../agent/prompts/loader.js";
import { ACADEMIC_STAGE_LABELS, type AcademicStage } from "../repository/academic.js";

/**
 * Academic-project chat context: the research workbench sends
 * `academic_project_id` with the turn — "the user asked this from inside project
 * X". The id is backend-issued but still treated as user input: parsed and
 * charset-filtered at the HTTP boundary, resolved against the caller's own
 * projects, and only ever rendered into a controlled system prompt section
 * (never into tool arguments or identity).
 *
 * The LLM-facing copy lives in prompts/chat/academic-context.md (repo
 * convention: prompt text belongs to prompts/, business code only renders it).
 */

/** Project ids are UUID-ish; cap + charset-filter before use. */
export const ACADEMIC_PROJECT_ID_MAX = 64;
/** Project titles are user input used only as a display label inside the section. */
export const ACADEMIC_PROJECT_TITLE_MAX = 200;

export interface AcademicContextParams {
  projectId: string;
}

/** Resolved project facts injected into the prompt (counts come from the service). */
export interface AcademicContextView {
  id: string;
  title: string;
  stage: AcademicStage;
  literatureCount: number;
  documentCount: number;
}

/** Collapse whitespace + strip control chars and prompt delimiters so a title cannot forge sections. */
function sanitizeLabel(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[「」#<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Parse the optional academic-project param off a chat request body. */
export function parseAcademicContext(body: { academic_project_id?: unknown }): AcademicContextParams | undefined {
  if (typeof body.academic_project_id !== "string") return undefined;
  const projectId = body.academic_project_id.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, ACADEMIC_PROJECT_ID_MAX);
  return projectId ? { projectId } : undefined;
}

/** Render the controlled academic-project section for this turn. */
export function buildAcademicSystemSection(prompts: PromptRegistry, view: AcademicContextView): string {
  return prompts.render("chat/academic-context", {
    PROJECT_ID: view.id,
    PROJECT_TITLE: sanitizeLabel(view.title, ACADEMIC_PROJECT_TITLE_MAX),
    STAGE: ACADEMIC_STAGE_LABELS[view.stage] ?? view.stage,
    LIT_COUNT: String(view.literatureCount),
    DOC_COUNT: String(view.documentCount),
  });
}
