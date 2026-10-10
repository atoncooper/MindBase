import type { KgBuildRecord } from "../../kg/types.js";
import type { KgBuildRepository } from "../kg-builds.js";

/** In-memory implementation (tests / degraded fallback). */
export class MemoryKgBuildStore implements KgBuildRepository {
  private readonly records = new Map<string, KgBuildRecord>();

  save(record: KgBuildRecord): Promise<void> {
    this.records.set(record.taskId, { ...record, steps: [...record.steps] });
    return Promise.resolve();
  }

  get(taskId: string, uid: string): Promise<KgBuildRecord | undefined> {
    const r = this.records.get(taskId);
    return Promise.resolve(r && r.uid === uid ? { ...r } : undefined);
  }

  findActive(uid: string): Promise<KgBuildRecord | undefined> {
    const found = [...this.records.values()]
      .filter((r) => r.uid === uid && r.status === "processing")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return Promise.resolve(found ? { ...found } : undefined);
  }

  async close(): Promise<void> {}
}
