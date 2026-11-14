import { randomUUID } from "node:crypto";
import type { AppCloudClient } from "../clients/app-cloud-client.js";
import type { ResearchWorkspace, ResearchWorkspaceRepository } from "../repository/research-workspaces.js";

export type ResearchFolderKind = "plan" | "literature" | "data" | "code" | "results" | "manuscript" | "submission";
export const PERMANENT_FOLDER_KINDS: ResearchFolderKind[] = ["plan", "literature", "manuscript", "submission"];
export const TEMPORARY_FOLDER_KINDS: ResearchFolderKind[] = ["data", "code", "results"];

const PROJECT_FOLDERS: Array<[keyof ResearchWorkspace["projects"][number]["folders"], string]> = [
  ["plan", "00_课题与计划"],
  ["literature", "01_文献"],
  ["data", "02_数据"],
  ["code", "03_代码与实验"],
  ["results", "04_结果"],
  ["manuscript", "05_论文"],
  ["submission", "06_投稿"],
];

export class ResearchWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchWorkspaceError";
  }
}

/**
 * Owns the cloud-drive folder hierarchy for research workspaces. app-cloud is
 * the storage owner; this service only orchestrates folder creation and keeps
 * the id mapping in Mongo.
 */
export class ResearchWorkspaceService {
  constructor(
    private readonly repo: ResearchWorkspaceRepository,
    private readonly cloud: AppCloudClient,
  ) {}

  async createWorkspace(uid: string, title: string): Promise<ResearchWorkspace> {
    if (!this.cloud.configured) throw new ResearchWorkspaceError("云盘服务暂时无法提供，无法创建学术空间");
    const name = title.trim() || "学术研究";
    const root = await this.cloud.createFolder(uid, name);
    const now = Date.now();
    const workspace: ResearchWorkspace = {
      workspaceId: randomUUID(),
      uid,
      title: name,
      rootFolderId: root.id,
      projects: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.create(workspace);
    return workspace;
  }

  async list(uid: string): Promise<ResearchWorkspace[]> {
    return this.repo.listByUid(uid);
  }

  async ensureProject(
    uid: string,
    projectId: string,
    title: string,
    workspaceId?: string,
  ): Promise<ResearchWorkspace> {
    if (!this.cloud.configured) throw new ResearchWorkspaceError("云盘服务未配置，无法创建课题目录");
    const existing = await this.repo.getByProject(uid, projectId);
    if (existing) return existing;

    let workspace = workspaceId ? await this.repo.get(workspaceId) : (await this.repo.listByUid(uid))[0];
    if (workspaceId && (!workspace || workspace.uid !== uid)) {
      throw new ResearchWorkspaceError("学术空间不存在或无权访问");
    }
    if (!workspace) workspace = await this.createWorkspace(uid, "学术研究");

    const projectName = title.trim() || projectId;
    const projectRoot = await this.cloud.createFolder(uid, projectName, workspace.rootFolderId);
    const folders = {} as ResearchWorkspace["projects"][number]["folders"];
    for (const [key, name] of PROJECT_FOLDERS) {
      const folder = await this.cloud.createFolder(uid, name, projectRoot.id);
      folders[key] = folder.id;
    }
    workspace.projects.push({
      projectId,
      title: projectName,
      rootFolderId: projectRoot.id,
      folders,
    });
    workspace.updatedAt = Date.now();
    await this.repo.save(workspace);
    return workspace;
  }

  /**
   * Delete files in temporary folders older than retentionDays. Papers and
   * literature (permanent kinds) are never touched by this sweeper.
   */
  async cleanupTemporary(retentionDays: number): Promise<{ scanned: number; deleted: number }> {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    const workspaces = await this.repo.listAll();
    let scanned = 0;
    let deleted = 0;
    for (const workspace of workspaces) {
      for (const project of workspace.projects) {
        for (const kind of TEMPORARY_FOLDER_KINDS) {
          const folderId = project.folders[kind];
          if (!folderId) continue;
          const files = await this.cloud.listFiles(workspace.uid, folderId);
          for (const file of files) {
            scanned += 1;
            if (file.createdAt && file.createdAt < cutoff) {
              try {
                await this.cloud.deleteFile(workspace.uid, file.upload_uuid);
                deleted += 1;
              } catch {
                // Best-effort sweeper: next run retries.
              }
            }
          }
        }
      }
    }
    return { scanned, deleted };
  }

  async findByProject(uid: string, projectId: string): Promise<ResearchWorkspace | undefined> {
    return this.repo.getByProject(uid, projectId);
  }

  /** Upload bytes into a project folder (02_数据 / 04_结果 / 05_论文 ...). */
  async uploadFile(
    uid: string,
    projectId: string,
    kind: ResearchFolderKind,
    name: string,
    data: Uint8Array,
    mimeType = "application/octet-stream",
  ): Promise<{ upload_uuid: string; name: string; size: number; sha256?: string; folderId: number }> {
    const workspace = await this.repo.getByProject(uid, projectId);
    const project = workspace?.projects.find((p) => p.projectId === projectId);
    if (!project) throw new ResearchWorkspaceError("项目还没有学术空间目录；请先 ensure_project。");
    const folderId = project.folders[kind];
    const result = await this.cloud.uploadFile(uid, folderId, name, data, mimeType);
    return { ...result, folderId };
  }

  async listFiles(
    uid: string,
    projectId: string,
    kind: ResearchFolderKind,
  ) {
    const workspace = await this.repo.getByProject(uid, projectId);
    const project = workspace?.projects.find((p) => p.projectId === projectId);
    if (!project) throw new ResearchWorkspaceError("项目还没有学术空间目录。");
    return this.cloud.listFiles(uid, project.folders[kind]);
  }

  /** Download one cloud-drive file's bytes (agent read_file / template import paths). */
  async downloadFile(uid: string, uploadUuid: string): Promise<{ contentType: string; data: Uint8Array }> {
    return this.cloud.downloadFile(uid, uploadUuid);
  }
}
