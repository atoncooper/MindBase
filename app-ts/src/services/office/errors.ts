/**
 * Domain error of the Office export path. Callers (the tool, future routes)
 * translate it into Chinese guidance text / HTTP status instead of throwing raw.
 */
export type OfficeExportErrorCode =
  /** the request is structurally invalid (empty deck, no rows, over-long text …) */
  | "invalid"
  /** the produced package exceeds the size ceiling */
  | "too_large"
  /** app-cloud is not configured or unreachable: the file could not be stored */
  | "cloud_unavailable";

export class OfficeExportError extends Error {
  readonly code: OfficeExportErrorCode;

  constructor(code: OfficeExportErrorCode, message: string) {
    super(message);
    this.name = "OfficeExportError";
    this.code = code;
  }
}
