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

  /**
   * Removes the project's folder mapping (cloud-drive files are not deleted here)
   * and drops the workspace row once it has no projects left. Returns the number
   * of project mappings removed.
   */
  async removeByProject(uid: string, projectId: string): Promise<number> {
    let removed = 0;
    for (const [workspaceId, workspace] of [...this.workspaces]) {
      if (workspace.uid !== uid) continue;
      const remaining = workspace.projects.filter((project) => project.projectId !== projectId);
      const count = workspace.projects.length - remaining.length;
      if (count === 0) continue;
      removed += count;
      if (remaining.length === 0) this.workspaces.delete(workspaceId);
      else this.workspaces.set(workspaceId, structuredClone({ ...workspace, projects: remaining, updatedAt: Date.now() }));
    }
    return removed;
  }
}
