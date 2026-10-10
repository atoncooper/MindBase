import type {
  VecPageRecord,
  VecTaskRecord,
  VectorTaskRepository,
} from "../vector-tasks.js";

/** In-memory implementation (tests / degraded fallback). */
export class MemoryVectorTaskStore implements VectorTaskRepository {
  private readonly pages = new Map<string, VecPageRecord>();
  private readonly tasks = new Map<string, VecTaskRecord>();

  private pageKey(bvid: string, cid: number): string {
    return `${bvid}:${cid}`;
  }

  async upsertPage(record: VecPageRecord): Promise<void> {
    this.pages.set(this.pageKey(record.bvid, record.cid), { ...record });
  }

  async getPage(bvid: string, cid: number): Promise<VecPageRecord | undefined> {
    const r = this.pages.get(this.pageKey(bvid, cid));
    return r ? { ...r } : undefined;
  }

  async listPagesByBvid(bvid: string): Promise<VecPageRecord[]> {
    return [...this.pages.values()]
      .filter((r) => r.bvid === bvid)
      .sort((a, b) => a.pageIndex - b.pageIndex)
      .map((r) => ({ ...r }));
  }

  async listAllPages(): Promise<VecPageRecord[]> {
    return [...this.pages.values()].map((r) => ({ ...r }));
  }

  async deletePagesByBvid(bvid: string): Promise<void> {
    for (const [key, r] of [...this.pages]) {
      if (r.bvid === bvid) this.pages.delete(key);
    }
  }

  async deleteAllPages(): Promise<void> {
    this.pages.clear();
  }

  async saveTask(record: VecTaskRecord): Promise<void> {
    this.tasks.set(record.taskId, { ...record, steps: [...record.steps] });
  }

  async getTask(taskId: string): Promise<VecTaskRecord | undefined> {
    const r = this.tasks.get(taskId);
    return r ? { ...r, steps: [...r.steps] } : undefined;
  }

  async close(): Promise<void> {}
}

