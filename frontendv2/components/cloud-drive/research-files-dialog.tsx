"use client";

/**
 * 云盘「科研项目文件」只读弹层。
 *
 * 云盘侧栏不展示科研工作台自动维护的「学术研究/<项目>/00_课题与计划…06_投稿」
 * 目录（避免误改结构）；这里提供只读入口：选择科研项目后复用 ProjectFilesPanel
 * （readOnly）查看 AI 生成/回存的项目文件，预览/下载/刷新保留，写操作仍在科研工作台。
 * 组件禁止直接 fetch：项目列表走 academicApi，文件/预览/下载由面板内 cloudApi 负责。
 * 关闭即卸载（项目列表/选择/面板状态全部丢弃，下次打开重新拉取）。
 */
import { useCallback, useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { academicApi, type AcademicProjectSummary } from "@/lib/api";
import { Select } from "@/components/ui/select";
import { ProjectFilesPanel } from "@/components/research/project-files-panel";
import { EmptyState, ErrorBanner, LoadingBlock, Modal } from "@/components/research/research-ui";

export function ResearchFilesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    // 弹层关闭即卸载内容组件（状态清零；下次打开重新拉项目列表）。
    if (!open) return null;
    return <ResearchFilesDialogContent onClose={onClose} />;
}

function ResearchFilesDialogContent({ onClose }: { onClose: () => void }) {
    const [projects, setProjects] = useState<AcademicProjectSummary[]>([]);
    const [projectId, setProjectId] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.listProjects();
            const list = result.projects;
            setProjects(list);
            // 默认选第一个；重新拉取后保留当前仍存在的选择。
            setProjectId((current) =>
                list.some((project) => project.id === current) ? current : (list[0]?.id ?? ""),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载科研项目失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // 首屏拉取。load() 会同步 setLoading(true)，放到定时器里执行以避开
        // react-hooks/set-state-in-effect 的同步级联渲染（同 plans-tab / 其它弹层）。
        const timer = window.setTimeout(() => void load(), 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    return (
        <Modal open title="科研项目文件" icon={FlaskConical} onClose={onClose} width="max-w-[880px]">
            <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg border-l-2 border-accent bg-accent-soft/60 px-3 py-2.5 text-[12px] leading-relaxed text-secondary">
                    <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <span>
                        只读：这些文件由科研工作台管理（00_课题与计划 … 06_投稿 / 写作来源与回存），
                        云盘不展示原始目录，避免误改结构。
                    </span>
                </div>

                {loading ? (
                    <LoadingBlock label="加载科研项目…" />
                ) : error ? (
                    <ErrorBanner message={error} onRetry={() => void load()} />
                ) : projects.length === 0 ? (
                    <EmptyState
                        icon={FlaskConical}
                        title="还没有科研项目"
                        description="在「科研」工作台创建项目后，AI 生成/回存的项目文件会在这里只读展示。"
                    />
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="shrink-0 text-[12px] font-medium text-secondary">项目</span>
                            <Select
                                value={projectId}
                                onChange={setProjectId}
                                options={projects.map((project) => ({
                                    value: project.id,
                                    label: project.title,
                                }))}
                                ariaLabel="选择科研项目"
                                className="min-w-[220px] max-w-[460px] flex-1"
                            />
                        </div>
                        {projectId && (
                            <ProjectFilesPanel projectId={projectId} title="项目文件" readOnly />
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
