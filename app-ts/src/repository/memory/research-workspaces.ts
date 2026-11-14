import type { ResearchWorkspace, ResearchWorkspaceRepository } from "../research-workspaces.js";

/** In-memory workspace store: tests + Mongo-unreachable fallback. */
export class MemoryResearchWorkspaceRepository implements ResearchWorkspaceRepository {
  private readonly workspaces = new Map<string, ResearchWorkspace>();

  async create(workspace: ResearchWorkspace): Promise<void> {
    this.workspaces.set(workspace.workspaceId, structuredClone(workspace));
  }

  async get(workspaceId: string): Promise<ResearchWorkspace | undefined> {
    const found = this.workspaces.get(workspaceId);
    return found ? structuredClone(found) : undefined;
  }

  async getByProject(uid: string, projectId: string): Promise<ResearchWorkspace | undefined> {
    for (const workspace of this.workspaces.values()) {
      if (workspace.uid === uid && workspace.projects.some((p) => p.projectId === projectId)) {
        return structuredClone(workspace);
      }
    }
    return undefined;
  }

  async listByUid(uid: string): Promise<ResearchWorkspace[]> {
    return [...this.workspaces.values()]
      .filter((workspace) => workspace.uid === uid)
      .map((workspace) => structuredClone(workspace));
  }

  async listAll(): Promise<ResearchWorkspace[]> {
    return [...this.workspaces.values()].map((workspace) => structuredClone(workspace));
  }

  async save(workspace: ResearchWorkspace): Promise<void> {
    this.workspaces.set(workspace.workspaceId, structuredClone(workspace));
  }
}
