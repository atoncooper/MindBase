"use client";

/**
 * 科研工作台视图：左侧项目列表 + 右侧项目详情（阶段步骤条 + 四个 Tab）。
 *
 * 数据流：项目列表 / 详情分别来自 GET /academic/projects 与
 * GET /academic/projects/:id；所有写操作由各 Tab 直接调用 academicApi，成功后
 * 通过 onChanged 回调静默刷新「详情 + 项目摘要计数」，不打断当前 Tab 的本地状态。
 * 阶段推进由概览 Tab 里的用户二次确认触发（PATCH 仅在确认后发出）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Activity,
    BookOpen,
    CalendarDays,
    FlaskConical,
    ListChecks,
    Loader2,
    MessageCircle,
    PenLine,
    RefreshCw,
    Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    academicApi,
    type AcademicProjectDetail,
    type AcademicProjectSummary,
} from "@/lib/api";
import { ProjectList } from "./project-list";
import { StageStepper } from "./stage-stepper";
import { OverviewTab } from "./overview-tab";
import { LiteratureTab } from "./literature-tab";
import { WritingTab } from "./writing-tab";
import { EventsTab } from "./events-tab";
import { NewProjectDialog } from "./new-project-dialog";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    PAPER_TYPE_LABELS,
    formatDate,
} from "./research-ui";

type Tab = "overview" | "literature" | "writing" | "events";

const TABS: { id: Tab; label: string; icon: typeof ListChecks }[] = [
    { id: "overview", label: "概览", icon: ListChecks },
    { id: "literature", label: "文献库", icon: BookOpen },
    { id: "writing", label: "写作", icon: PenLine },
    { id: "events", label: "动态", icon: Activity },
];

export function ResearchView() {
    const router = useRouter();
    const [projects, setProjects] = useState<AcademicProjectSummary[]>([]);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const [detail, setDetail] = useState<AcademicProjectDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    const [tab, setTab] = useState<Tab>("overview");
    const [createOpen, setCreateOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    // 只接受「当前选中项目」的最新响应，避免快速切换时旧响应覆盖新详情。
    // 仅在 effect 中同步 ref（渲染期写 ref 违反 react-hooks/refs）。
    const selectedRef = useRef<string | null>(null);

    const loadProjects = useCallback(async (silent = false) => {
        if (!silent) setProjectsLoading(true);
        setProjectsError(null);
        try {
            const result = await academicApi.listProjects();
            setProjects(result.projects);
            // 选中项仍存在则保留；否则（首次加载 / 项目已删）回落到第一个项目。
            setSelectedId((current) => {
                if (current && result.projects.some((project) => project.id === current)) return current;
                return result.projects[0]?.id ?? null;
            });
        } catch (e) {
            setProjectsError(e instanceof Error ? e.message : "加载项目列表失败");
        } finally {
            if (!silent) setProjectsLoading(false);
        }
    }, []);

    const loadDetail = useCallback(async (projectId: string, silent = false) => {
        if (!silent) setDetailLoading(true);
        setDetailError(null);
        try {
            const result = await academicApi.getProject(projectId);
            if (selectedRef.current === projectId) setDetail(result);
        } catch (e) {
            if (selectedRef.current === projectId) {
                setDetailError(e instanceof Error ? e.message : "加载项目详情失败");
            }
        } finally {
            if (!silent && selectedRef.current === projectId) setDetailLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadProjects();
    }, [loadProjects]);

    useEffect(() => {
        selectedRef.current = selectedId;
        setDetail(null);
        setDetailError(null);
        if (selectedId) {
            setTab("overview");
            void loadDetail(selectedId);
        }
    }, [selectedId, loadDetail]);

    /** 写操作后的静默刷新：详情 + 项目摘要（文献/稿件计数）。 */
    const onChanged = useCallback(async () => {
        if (!selectedId) return;
        await Promise.all([loadDetail(selectedId, true), loadProjects(true)]);
    }, [selectedId, loadDetail, loadProjects]);

    const manualRefresh = useCallback(async () => {
        if (!selectedId) return;
        setRefreshing(true);
        try {
            await Promise.all([loadDetail(selectedId, true), loadProjects(true)]);
        } finally {
            setRefreshing(false);
        }
    }, [selectedId, loadDetail, loadProjects]);

    const project = detail?.project ?? projects.find((item) => item.id === selectedId) ?? null;

    return (
        <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-[1240px] flex-1 flex-col px-4 py-6 sm:px-8">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-foreground">
                        <FlaskConical className="h-5 w-5 text-accent" />
                        科研工作台
                    </h1>
                    <p className="mt-1 text-[12px] text-secondary">
                        管理研究项目、文献库与论文稿件；也可以直接在对话中交给学术智能体处理。
                    </p>
                </div>
            </header>

            <div className="mt-5 flex min-h-0 flex-1 flex-col items-stretch gap-4 lg:flex-row">
                <div className="flex min-h-0 flex-col lg:w-[280px] lg:flex-none">
                    <ProjectList
                    projects={projects}
                    loading={projectsLoading}
                    error={projectsError}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onRetry={() => void loadProjects()}
                        onCreate={() => setCreateOpen(true)}
                    />
                </div>

                <section className="flex min-w-0 flex-1 flex-col">
                    {!selectedId ? (
                        <div className="rounded-xl border border-border-subtle bg-surface">
                            <EmptyState
                                icon={FlaskConical}
                                title="选择或新建一个研究项目"
                                description="科研项目把文献库、阶段计划、写作稿件和动态关联在一起。"
                                action={
                                    <button
                                        type="button"
                                        onClick={() => setCreateOpen(true)}
                                        className="rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                                    >
                                        新建项目
                                    </button>
                                }
                            />
                        </div>
                    ) : detailLoading && !detail ? (
                        <div className="rounded-xl border border-border-subtle bg-surface">
                            <LoadingBlock label="加载项目详情…" />
                        </div>
                    ) : detailError && !detail ? (
                        <div className="rounded-xl border border-border-subtle bg-surface p-4">
                            <ErrorBanner message={detailError} onRetry={() => void loadDetail(selectedId)} />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* 详情头 */}
                            <div className="rounded-xl border border-border-subtle bg-surface p-4">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <h2 className="truncate text-[17px] font-semibold tracking-tight text-foreground">
                                            {project?.title ?? "…"}
                                        </h2>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-secondary">
                                            <span className="inline-flex items-center gap-1">
                                                <Tag className="h-3 w-3" />
                                                {project ? PAPER_TYPE_LABELS[project.paperType] : "—"}
                                            </span>
                                            <span>领域：{project?.field || "未填写"}</span>
                                            <span>目标期刊：{project?.targetJournal || "未填写"}</span>
                                            <span className="inline-flex items-center gap-1">
                                                <CalendarDays className="h-3 w-3" />
                                                截止：
                                                {project?.deadline
                                                    ? formatDate(new Date(project.deadline).getTime())
                                                    : "未设置"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        {/* 把当前项目作为聊天上下文：/chat 读取 ?academic_project= 并注入受控项目提示 */}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (!project) return;
                                                router.push(
                                                    `/chat?academic_project=${encodeURIComponent(project.id)}`,
                                                );
                                            }}
                                            disabled={!project}
                                            className="inline-flex items-center gap-1 rounded-full bg-foreground px-3 py-1 text-[11px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
                                        >
                                            <MessageCircle className="h-3 w-3" />
                                            在对话中继续
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void manualRefresh()}
                                            disabled={refreshing}
                                            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                                        >
                                            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
                                            刷新
                                        </button>
                                    </div>
                                </div>

                                {project && (
                                    <div className="mt-3 border-t border-border-subtle pt-3">
                                        <StageStepper
                                            stages={project.stages}
                                            current={project.stage}
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Tab 切换 */}
                            <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                                {TABS.map((item) => {
                                    const Icon = item.icon;
                                    const active = tab === item.id;
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => setTab(item.id)}
                                            className={cn(
                                                "inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                                                active
                                                    ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
                                                    : "text-secondary hover:text-foreground",
                                            )}
                                        >
                                            <Icon className="h-3.5 w-3.5" />
                                            {item.label}
                                        </button>
                                    );
                                })}
                                {refreshing && <Loader2 className="ml-2 h-3 w-3 animate-spin text-tertiary" />}
                            </div>

                            {/* Tab 内容 */}
                            {!detail ? (
                                <div className="rounded-xl border border-border-subtle bg-surface">
                                    <LoadingBlock label="加载项目详情…" />
                                </div>
                            ) : tab === "overview" ? (
                                <OverviewTab detail={detail} onChanged={onChanged} />
                            ) : tab === "literature" ? (
                                <LiteratureTab projectId={detail.project.id} onChanged={onChanged} />
                            ) : tab === "writing" ? (
                                <WritingTab projectId={detail.project.id} onChanged={onChanged} />
                            ) : (
                                <EventsTab projectId={detail.project.id} />
                            )}
                        </div>
                    )}
                </section>
            </div>

            <NewProjectDialog
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onCreated={(created) => {
                    void loadProjects(true);
                    setSelectedId(created.project.id);
                    setDetail(created);
                    setTab("overview");
                }}
            />
        </div>
    );
}
