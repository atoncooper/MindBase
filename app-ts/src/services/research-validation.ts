import type {
  AcademicDocument,
  AcademicDocumentRepository,
  AcademicLiteratureRepository,
  AcademicProjectRepository,
} from "../repository/academic.js";
import type { AcademicEvidenceRepository } from "../repository/academic-evidence.js";

export interface ResearchValidationReport {
  pass: boolean;
  citations: { total: number; missing: string[]; unverified: string[] };
  runs: { total: number; unreproducible: string[] };
  results: { sections: string[]; withoutEvidenceRef: string[] };
}

function citationKeys(text: string): string[] {
  const keys = new Set<string>();
  const re = /\\cite\{([^}]+)\}|\[@([^\]]+)\]/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    for (const key of raw.split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys];
}

function isResultsSection(title: string): boolean {
  return /结果|result|实验|experiment/i.test(title);
}

/**
 * Academic integrity checks over a manuscript + evidence ledger:
 *  - every citation key must exist and be verified;
 *  - every succeeded run must carry a script hash (reproducibility);
 *  - results sections with numbers must reference a run via [[run:<id>]].
 */
export class ResearchValidationService {
  constructor(
    private readonly projects: AcademicProjectRepository,
    private readonly documents: AcademicDocumentRepository,
    private readonly literature: AcademicLiteratureRepository,
    private readonly evidence: AcademicEvidenceRepository,
  ) {}

  async validate(uid: string, projectId: string, documentId?: string): Promise<ResearchValidationReport> {
    const project = await this.projects.get(uid, projectId);
    if (!project) throw new Error("项目不存在或无权访问");
    const docs: AcademicDocument[] = documentId
      ? ([await this.documents.getDocument(uid, documentId)].filter(Boolean) as AcademicDocument[])
      : await this.documents.listDocuments(uid, projectId);
    const library = await this.literature.list(uid, projectId);
    const byKey = new Map(library.map((entry) => [entry.citeKey.toLowerCase(), entry]));

    const allKeys = new Set<string>();
    const resultSections: string[] = [];
    const withoutEvidenceRef: string[] = [];
    for (const doc of docs) {
      for (const section of doc.sections) {
        for (const key of citationKeys(section.content)) allKeys.add(key);
        if (isResultsSection(section.title)) {
          resultSections.push(section.title);
          const hasNumber = /\d+(?:\.\d+)?\s*%?/.test(section.content);
          const hasRef = /\[\[run:[a-zA-Z0-9_-]+\]\]/.test(section.content);
          if (hasNumber && !hasRef) withoutEvidenceRef.push(section.title);
        }
      }
    }
    const missing: string[] = [];
    const unverified: string[] = [];
    for (const key of allKeys) {
      const entry = byKey.get(key.toLowerCase());
      if (!entry) missing.push(key);
      else if (!entry.verified) unverified.push(key);
    }

    const runs = await this.evidence.listRuns(uid, projectId, { limit: 100 });
    const unreproducible = runs
      .filter((run) => run.status === "succeeded" && !run.scriptSha256)
      .map((run) => run.id);

    return {
      pass: missing.length === 0 && unverified.length === 0 && unreproducible.length === 0 && withoutEvidenceRef.length === 0,
      citations: { total: allKeys.size, missing, unverified },
      runs: { total: runs.length, unreproducible },
      results: { sections: resultSections, withoutEvidenceRef },
    };
  }
}
