/**
 * MikroORM entity for the app-ts academic evidence collection (academic_runs).
 *
 * EntitySchema (not decorators) keeps app-ts' existing tsconfig and ESM setup
 * untouched. Field names mirror the documents written by the legacy direct-driver
 * adapter so both implementations can share the same collection during migration.
 */
import { EntitySchema } from "@mikro-orm/mongodb";
import type { AcademicEvidenceFile, AcademicRunStatus } from "../../academic-evidence.js";

/** Stored shape: dataset and run rows share one collection, discriminated by kind. */
export interface AcademicEvidenceRecordEntity {
  id: string;
  uid: string;
  projectId: string;
  kind: "dataset" | "run";
  createdAt: number;
  name: string;
  description?: string;
  source?: string;
  files?: AcademicEvidenceFile[];
  datasetId?: string;
  script?: string;
  scriptSha256?: string;
  language?: string;
  executionId?: string;
  status?: AcademicRunStatus;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  artifacts?: AcademicEvidenceFile[];
  cpuMillis?: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Single collection + the same two compound indexes as the direct-driver adapter. */
export const AcademicEvidenceRecord = new EntitySchema<AcademicEvidenceRecordEntity>({
  name: "AcademicEvidenceRecord",
  collection: "academic_runs",
  properties: {
    id: { type: "string", primary: true, fieldName: "_id" },
    uid: { type: "string" },
    projectId: { type: "string" },
    kind: { type: "string" },
    createdAt: { type: "number" },
    name: { type: "string" },
    description: { type: "string", nullable: true },
    source: { type: "string", nullable: true },
    files: { type: "json", nullable: true },
    datasetId: { type: "string", nullable: true },
    script: { type: "string", nullable: true },
    scriptSha256: { type: "string", nullable: true },
    language: { type: "string", nullable: true },
    executionId: { type: "string", nullable: true },
    status: { type: "string", nullable: true },
    exitCode: { type: "number", nullable: true },
    stdoutPreview: { type: "string", nullable: true },
    stderrPreview: { type: "string", nullable: true },
    artifacts: { type: "json", nullable: true },
    cpuMillis: { type: "number", nullable: true },
    startedAt: { type: "number", nullable: true },
    finishedAt: { type: "number", nullable: true },
  },
  indexes: [
    // Newest-first evidence feed of one project (datasets + runs interleaved).
    { properties: ["uid", "projectId", "createdAt"] },
    // Kind filter for listDatasets/listRuns inside one project.
    { properties: ["uid", "projectId", "kind"] },
  ],
});
