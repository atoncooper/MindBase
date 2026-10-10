import type { SkillMetaRepository, SkillRecord } from "../../skills/manager.js";

/** In-memory implementation (tests / degraded fallback). */
export class MemorySkillMetaStore implements SkillMetaRepository {
  private readonly rows = new Map<string, SkillRecord>();

  private key(uid: string, skillId: string): string {
    return `${uid}:${skillId}`;
  }

  async list(uid: string): Promise<SkillRecord[]> {
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${uid}:`))
      .map(([, r]) => ({ ...r }));
  }

  async get(uid: string, skillId: string): Promise<SkillRecord | undefined> {
    const r = this.rows.get(this.key(uid, skillId));
    return r ? { ...r } : undefined;
  }

  async save(uid: string, record: SkillRecord): Promise<void> {
    this.rows.set(this.key(uid, record.skillId), { ...record });
  }

  async remove(uid: string, skillId: string): Promise<boolean> {
    return this.rows.delete(this.key(uid, skillId));
  }

  async close(): Promise<void> {}
}
