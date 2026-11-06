import type { KgDocRecord } from "../../kg/types.js";
import type { KgDocRepository } from "../kg-docs.js";

/** In-memory implementation (tests / degraded fallback). Key = uid + uploadUuid. */
export class MemoryKgDocStore implements KgDocRepository {
  private readonly records = new Map<string, KgDocRecord>();

  private key(uid: string, uploadUuid: string): string {
    return `${uid}:${uploadUuid}`;
  }

  async get(uid: string, uploadUuid: string): Promise<KgDocRecord | undefined> {
    const record = this.records.get(this.key(uid, uploadUuid));
    return record ? { ...record } : undefined;
  }

  async save(record: KgDocRecord): Promise<void> {
    this.records.set(this.key(record.uid, record.uploadUuid), { ...record });
  }

  async close(): Promise<void> {}
}
