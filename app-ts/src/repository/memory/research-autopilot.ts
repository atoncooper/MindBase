import type { ResearchAutopilotRepository, ResearchAutopilotSetting } from "../research-autopilot.js";

/**
 * In-process autopilot store (tests + MongoDB-unreachable fallback): one row per
 * (uid, projectId), cloned on every read/write so callers never alias storage.
 */
export class MemoryResearchAutopilotRepository implements ResearchAutopilotRepository {
  private readonly items = new Map<string, ResearchAutopilotSetting>();

  async get(uid: string, projectId: string): Promise<ResearchAutopilotSetting | undefined> {
    const found = this.items.get(keyOf(uid, projectId));
    return found ? structuredClone(found) : undefined;
  }

  async save(setting: ResearchAutopilotSetting): Promise<void> {
    this.items.set(keyOf(setting.uid, setting.projectId), structuredClone(setting));
  }

  /** Scheduler enumeration: configured, not-off and not emergency-stopped rows. */
  async listActive(): Promise<ResearchAutopilotSetting[]> {
    return [...this.items.values()]
      .filter((setting) => setting.mode !== "off" && setting.stoppedAt === undefined)
      .map((setting) => structuredClone(setting));
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    return this.items.delete(keyOf(uid, projectId)) ? 1 : 0;
  }
}

/** Composite key; the NUL separator cannot occur in a uid or a project id. */
function keyOf(uid: string, projectId: string): string {
  return uid + "\u0000" + projectId;
}
