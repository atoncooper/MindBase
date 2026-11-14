/**
 * Research workspace hierarchy: 学术研究空间 → 论文题目/课题 → 云盘目录树.
 * MongoDB stores only the folder mapping; file bytes and folder rows live in
 * app-cloud (the cloud-drive owner).
 */
export interface ResearchProjectWorkspace {
  projectId: string;
  title: string;
  rootFolderId: number;
  folders: {
    plan: number;
    literature: number;
    data: number;
    code: number;
    results: number;
    manuscript: number;
    submission: number;
  };
}

export interface ResearchWorkspace {
  workspaceId: string;
  uid: string;
  title: string;
  rootFolderId: number;
  projects: ResearchProjectWorkspace[];
  createdAt: number;
  updatedAt: number;
}

export interface ResearchWorkspaceRepository {
  create(workspace: ResearchWorkspace): Promise<void>;
  get(workspaceId: string): Promise<ResearchWorkspace | undefined>;
  getByProject(uid: string, projectId: string): Promise<ResearchWorkspace | undefined>;
  listByUid(uid: string): Promise<ResearchWorkspace[]>;
  /** All workspaces (retention sweeper). */
  listAll(): Promise<ResearchWorkspace[]>;
  save(workspace: ResearchWorkspace): Promise<void>;
}
