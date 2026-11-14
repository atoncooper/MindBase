"use client";

/**
 * 学术空间 Tab：项目在云盘里的目录树与文件（research_workspace）。
 *
 * 文件列表、按目录分组、点击预览与下载统一由 ProjectFilesPanel 提供；
 * 还没有空间时面板内置「创建学术空间」入口（POST 幂等 ensureProject）。
 */
import { ProjectFilesPanel } from "./project-files-panel";

export function WorkspaceTab({
    projectId,
    onChanged,
}: {
    projectId: string;
    onChanged?: () => void;
}) {
    return <ProjectFilesPanel projectId={projectId} onChanged={onChanged} />;
}
