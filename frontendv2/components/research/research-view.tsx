"use client";

/**
 * 科研工作台视图（改版）：Google Workspace / Material 风格外壳，左侧项目列表 +
 * 右侧项目详情（MUI 阶段步骤条 + 十一个 MUI Tab）。
 *
 * 数据流保持不变：项目列表 / 详情分别来自 GET /academic/projects 与
 * GET /academic/projects/:id；所有写操作由各 Tab 直接调用 academicApi，成功后
 * 通过 onChanged 回调静默刷新「详情 + 项目摘要计数」，不打断当前 Tab 的本地状态。
 * 阶段推进由概览 Tab 里的用户二次确认触发（PATCH 仅在确认后发出）。
 *
 * 视觉：根节点包一层 <GoogleResearchTheme>（MUI theme + ScopedCssBaseline），
 * 外壳用 MUI 组件；各 Tab 内部不改代码，通过 research-ui 共享原语自动获得
 * Google 风格。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Activity,
    Beaker,
    ShieldCheck,
    BookOpen,
    CalendarDays,
    ClipboardCheck,
    Database,
    FlaskConical,
    FolderTree,
    ListChecks,
    Menu,
    MessageCircle,
    PenLine,
    Plus,
    RefreshCw,
    Table2,
    Tag,
    Trash2,
    Workflow,
} from "lucide-react";
import {
    Box,
    Button,
    CircularProgress,
    Drawer,
    IconButton,
    Stack,
    Tab,
    Tabs,
    Tooltip,
    Typography,
    alpha,
} from "@mui/material";
import {
    academicApi,
    type AcademicProjectDetail,
    type AcademicProjectSummary,
    type AcademicStage,
} from "@/lib/api";
import { ProjectList } from "./project-list";
import { StageStepper } from "./stage-stepper";
import { OverviewTab } from "./overview-tab";
import { LiteratureTab } from "./literature-tab";
import { WritingTab } from "./writing-tab";
import { ExperimentsTab } from "./experiments-tab";
import { EvidenceTab } from "./evidence-tab";
import { ValidationTab } from "./validation-tab";
import { AnalysisTab } from "./analysis-tab";
import { WorkspaceTab } from "./workspace-tab";
import { PlansTab } from "./plans-tab";
import { EventsTab } from "./events-tab";
import { ApprovalTab } from "./approval-tab";
import { NewProjectDialog } from "./new-project-dialog";
import { NotificationCenter } from "./notification-center";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    PAPER_TYPE_LABELS,
    formatDate,
    SurfaceCard,
} from "./research-ui";
import { GoogleResearchTheme } from "./google-theme";

type Tab =
    | "overview"
    | "literature"
    | "writing"
    | "experiments"
    | "evidence"
    | "validation"
    | "analysis"
    | "workspace"
    | "plans"
    | "approvals"
    | "events";

const TABS: { id: Tab; label: string; icon: typeof ListChecks }[] = [
    { id: "overview", label: "概览", icon: ListChecks },
    { id: "literature", label: "文献库", icon: BookOpen },
    { id: "writing", label: "写作", icon: PenLine },
    { id: "experiments", label: "实验", icon: Beaker },
    { id: "evidence", label: "证据", icon: Database },
    { id: "validation", label: "校验", icon: ClipboardCheck },
    { id: "analysis", label: "分析", icon: Table2 },
    { id: "workspace", label: "空间", icon: FolderTree },
    { id: "plans", label: "计划", icon: Workflow },
    { id: "approvals", label: "审批", icon: ShieldCheck },
    { id: "events", label: "动态", icon: Activity },
];

const TAB_IDS = new Set<string>(TABS.map((item) => item.id));

/** 解析 ?tab= 参数：只接受已知 Tab id，非法值忽略。 */
function parseTabParam(value: string | null): Tab | null {
    return value && TAB_IDS.has(value) ? (value as Tab) : null;
}

export function ResearchView() {
    // useSearchParams（?project=&tab= 深链）需要 Suspense 边界。
    return (
        <Suspense
            fallback={
                <Box sx={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
                    <LoadingBlock label="加载科研工作台…" />
                </Box>
            }
        >
            <ResearchViewContent />
        </Suspense>
    );
}

function ResearchViewContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [projects, setProjects] = useState<AcademicProjectSummary[]>([]);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const [detail, setDetail] = useState<AcademicProjectDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    const [tab, setTab] = useState<Tab>("overview");
    const [createOpen, setCreateOpen] = useState(false);
    const [mobileProjectsOpen, setMobileProjectsOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const [stageView, setStageView] = useState<AcademicStage | null>(null);

    // 只接受「当前选中项目」的最新响应，避免快速切换时旧响应覆盖新详情。
    // 仅在 effect 中同步 ref（渲染期写 ref 违反 react-hooks/refs）。
    const selectedRef = useRef<string | null>(null);
    // 深链（?project=<id>&tab=<tabId>，通知/外链跳转）：只按 URL 查询串定向，
    // 用户手动切 Tab 不改 URL，因此不会被覆盖。
    const deepLinkQuery = searchParams.toString();
    const lastDeepLinkRef = useRef<string | null>(null);
    const pendingTabRef = useRef<{ projectId: string; tab: Tab } | null>(null);

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
        // 首次加载项目列表（沿用原有 effect 数据流；状态在 fetch 后落定）。
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial list bootstrap, pre-existing pattern
        void loadProjects();
    }, [loadProjects]);

    // ?project=<id>&tab=<tabId> 定向：项目在列表中才生效，非法/不存在的项目忽略。
    useEffect(() => {
        /* eslint-disable react-hooks/set-state-in-effect -- 深链定向（URL 查询串变化时切换项目/Tab） */
        if (projectsLoading) return;
        if (lastDeepLinkRef.current === deepLinkQuery) return;
        const projectId = searchParams.get("project");
        if (!projectId) {
            lastDeepLinkRef.current = deepLinkQuery;
            return;
        }
        // 列表不可用（加载失败/为空）时先不消费 URL，待列表重试成功后再生效。
        if (projects.length === 0) return;
        lastDeepLinkRef.current = deepLinkQuery;
        if (!projects.some((item) => item.id === projectId)) return;
        const targetTab = parseTabParam(searchParams.get("tab")) ?? "overview";
        pendingTabRef.current = { projectId, tab: targetTab };
        if (projectId === selectedId) {
            setTab(targetTab);
        } else {
            setSelectedId(projectId);
        }
        /* eslint-enable react-hooks/set-state-in-effect */
    }, [deepLinkQuery, projects, projectsLoading, searchParams, selectedId]);

    useEffect(() => {
        /* eslint-disable react-hooks/set-state-in-effect -- reset per-project view state when the selection changes (pre-existing pattern) */
        selectedRef.current = selectedId;
        setDetail(null);
        setDetailError(null);
        setStageView(null);
        if (selectedId) {
            // 深链带来的 Tab 只在本次切换中生效，其余切换仍回到概览。
            const pending = pendingTabRef.current;
            pendingTabRef.current = null;
            setTab(pending && pending.projectId === selectedId ? pending.tab : "overview");
            void loadDetail(selectedId);
        }
    /* eslint-enable react-hooks/set-state-in-effect */
    }, [selectedId, loadDetail]);

    // 项目阶段变化（推进/回滚）后回到“当前阶段”，避免继续展示旧阶段的计划/建议。
    useEffect(() => {
        /* eslint-disable-next-line react-hooks/set-state-in-effect -- reset view-stage when the project/stage changes */
        setStageView(null);
    }, [detail?.project.id, detail?.project.stage]);

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

    const archiveSelected = useCallback(async () => {
        if (!selectedId) return;
        setRefreshing(true);
        try {
            await academicApi.deleteProject(selectedId);
            setSelectedId(null);
            await loadProjects(true);
        } catch (e) {
            setDetailError(e instanceof Error ? e.message : "移入回收站失败");
        } finally {
            setRefreshing(false);
        }
    }, [selectedId, loadProjects]);

    const project = detail?.project ?? projects.find((item) => item.id === selectedId) ?? null;

    // Full-screen shell: rail (brand + project list + search) on the left, project
    // detail + tabs + scrollable content on the right. Mirrors the chat layout.
    const projectRail = (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: 0,
                bgcolor: "#fff",
            }}
        >
            <Stack
                direction="row"
                spacing={1.25}
                sx={{ alignItems: "center", px: 2, py: 1.5, flexShrink: 0 }}
            >
                <Box
                    sx={{
                        display: "grid",
                        placeItems: "center",
                        width: 34,
                        height: 34,
                        flexShrink: 0,
                        borderRadius: "8px",
                        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                        color: "primary.main",
                    }}
                >
                    <FlaskConical size={18} aria-hidden="true" />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
                        科研工作台
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                        Research Workspace
                    </Typography>
                </Box>
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, px: 1.5, pb: 1.5 }}>
                <ProjectList
                    projects={projects}
                    loading={projectsLoading}
                    error={projectsError}
                    selectedId={selectedId}
                    onSelect={(id) => {
                        setSelectedId(id);
                        setMobileProjectsOpen(false);
                    }}
                    onRetry={() => void loadProjects()}
                    onCreate={() => setCreateOpen(true)}
                    embedded
                />
            </Box>
        </Box>
    );

    return (
        <GoogleResearchTheme>
            <Box
                className="research-app"
                sx={{
                    display: "flex",
                    height: "100%",
                    minHeight: 0,
                    overflow: "hidden",
                    bgcolor: "background.default",
                }}
            >
                {/* Desktop project rail */}
                <Box
                    sx={{
                        display: { xs: "none", md: "flex" },
                        flexDirection: "column",
                        width: 340,
                        flexShrink: 0,
                        minHeight: 0,
                        borderRight: 1,
                        borderColor: "divider",
                    }}
                >
                    {projectRail}
                </Box>

                {/* Mobile project rail */}
                <Drawer
                    anchor="left"
                    open={mobileProjectsOpen}
                    onClose={() => setMobileProjectsOpen(false)}
                    sx={{
                        display: { xs: "block", md: "none" },
                        "& .MuiDrawer-paper": {
                            width: 330,
                            maxWidth: "88vw",
                            borderRight: 1,
                            borderColor: "divider",
                            boxSizing: "border-box",
                        },
                    }}
                >
                    {projectRail}
                </Drawer>

                {/* Main detail pane */}
                <Box
                    component="section"
                    sx={{
                        display: "flex",
                        flexDirection: "column",
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                    }}
                >
                    <Box
                        sx={{
                            flexShrink: 0,
                            bgcolor: "#fff",
                            borderBottom: 1,
                            borderColor: "divider",
                            px: { xs: 2, md: 3 },
                            pt: { xs: 1.25, md: 2 },
                        }}
                    >
                        <Stack
                            direction="row"
                            spacing={1.5}
                            sx={{ alignItems: "flex-start", minWidth: 0 }}
                        >
                            <IconButton
                                aria-label="打开项目列表"
                                onClick={() => setMobileProjectsOpen(true)}
                                sx={{ display: { md: "none" }, mt: 0.25 }}
                            >
                                <Menu size={20} aria-hidden="true" />
                            </IconButton>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                                <Typography
                                    variant="h2"
                                    sx={{ fontSize: 20, lineHeight: 1.3, wordBreak: "break-word" }}
                                >
                                    {project?.title ?? "科研工作台"}
                                </Typography>
                                {project ? (
                                    <Stack
                                        direction="row"
                                        spacing={{ xs: 1, sm: 2 }}
                                        useFlexGap
                                        sx={{
                                            mt: 0.75,
                                            flexWrap: "wrap",
                                            color: "text.secondary",
                                            fontSize: 12,
                                        }}
                                    >
                                        <Box
                                            component="span"
                                            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
                                        >
                                            <Tag size={13} aria-hidden="true" />
                                            {PAPER_TYPE_LABELS[project.paperType]}
                                        </Box>
                                        <Box component="span">领域：{project.field || "未填写"}</Box>
                                        <Box component="span">
                                            目标期刊：{project.targetJournal || "未填写"}
                                        </Box>
                                        <Box
                                            component="span"
                                            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
                                        >
                                            <CalendarDays size={13} aria-hidden="true" />
                                            截止：
                                            {project.deadline
                                                ? formatDate(new Date(project.deadline).getTime())
                                                : "未设置"}
                                        </Box>
                                    </Stack>
                                ) : (
                                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                                        从左侧选择或新建研究项目。
                                    </Typography>
                                )}
                            </Box>
                            <Stack
                                direction="row"
                                spacing={1}
                                sx={{ alignItems: "center", flexShrink: 0 }}
                            >
                                <Tooltip title="刷新">
                                    <span>
                                        <IconButton
                                            aria-label="刷新"
                                            onClick={() => void manualRefresh()}
                                            disabled={!selectedId || refreshing}
                                            sx={{
                                                border: 1,
                                                borderColor: "divider",
                                                borderRadius: "8px",
                                                color: "text.secondary",
                                            }}
                                        >
                                            {refreshing ? (
                                                <CircularProgress size={16} thickness={5} />
                                            ) : (
                                                <RefreshCw size={16} aria-hidden="true" />
                                            )}
                                        </IconButton>
                                    </span>
                                </Tooltip>
                                {project && (
                                    <Tooltip title="移入回收站">
                                        <span>
                                            <IconButton
                                                aria-label="移入回收站"
                                                onClick={() => setArchiveOpen(true)}
                                                disabled={refreshing}
                                                sx={{
                                                    border: 1,
                                                    borderColor: "divider",
                                                    borderRadius: "8px",
                                                    color: "text.secondary",
                                                }}
                                            >
                                                <Trash2 size={16} aria-hidden="true" />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                )}
                                {project && (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        startIcon={<MessageCircle size={14} aria-hidden="true" />}
                                        onClick={() => {
                                            if (!project) return;
                                            router.push(
                                                `/chat?academic_project=${encodeURIComponent(project.id)}&new=1`,
                                            );
                                        }}
                                        sx={{ display: { xs: "none", sm: "inline-flex" } }}
                                    >
                                        在对话中继续
                                    </Button>
                                )}
                                <Button
                                    variant="outlined"
                                    size="small"
                                    startIcon={<Plus size={14} aria-hidden="true" />}
                                    onClick={() => setCreateOpen(true)}
                                    sx={{ display: { xs: "none", sm: "inline-flex" } }}
                                >
                                    新建项目
                                </Button>
                                {/* 账号维度通知中心：projectId 仅用于标记「本项目」通知，不过滤 */}
                                <NotificationCenter projectId={project?.id} />
                            </Stack>
                        </Stack>

                        {project && (
                            <Box sx={{ mt: 1.5, minWidth: 0 }}>
                                <StageStepper
                                    stages={project.stages}
                                    current={project.stage}
                                    selected={stageView ?? project.stage}
                                    onSelect={(next) => {
                                        setStageView(next);
                                        setTab("overview");
                                    }}
                                />
                            </Box>
                        )}

                        {selectedId && (
                            <Tabs
                                value={tab}
                                onChange={(event, value) => setTab(value as Tab)}
                                variant="scrollable"
                                allowScrollButtonsMobile
                                aria-label="科研项目标签页"
                                sx={{ mt: 1, minHeight: 42 }}
                            >
                                {TABS.map((item) => {
                                    const Icon = item.icon;
                                    return (
                                        <Tab
                                            key={item.id}
                                            value={item.id}
                                            label={item.label}
                                            icon={<Icon size={16} aria-hidden="true" />}
                                            iconPosition="start"
                                        />
                                    );
                                })}
                            </Tabs>
                        )}
                    </Box>

                    {/* Scrollable detail / tab content */}
                    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                        <Box
                            sx={{
                                width: "100%",
                                maxWidth: 1280,
                                mx: "auto",
                                px: { xs: 2, md: 3 },
                                py: { xs: 2, md: 2.5 },
                            }}
                        >
                            {!selectedId ? (
                                <Box sx={{ py: { xs: 6, md: 10 } }}>
                                    <EmptyState
                                        icon={FlaskConical}
                                        title="选择或新建一个研究项目"
                                        description="科研项目把文献库、阶段计划、写作稿件和动态关联在一起。"
                                        action={
                                            <Button
                                                variant="contained"
                                                startIcon={<Plus size={14} aria-hidden="true" />}
                                                onClick={() => setCreateOpen(true)}
                                            >
                                                新建项目
                                            </Button>
                                        }
                                    />
                                </Box>
                            ) : detailLoading && !detail ? (
                                <SurfaceCard>
                                    <LoadingBlock label="加载项目详情…" />
                                </SurfaceCard>
                            ) : detailError && !detail ? (
                                <SurfaceCard>
                                    <ErrorBanner
                                        message={detailError}
                                        onRetry={() => void loadDetail(selectedId)}
                                    />
                                </SurfaceCard>
                            ) : !detail ? (
                                <SurfaceCard>
                                    <LoadingBlock label="加载项目详情…" />
                                </SurfaceCard>
                            ) : tab === "overview" ? (
                                <OverviewTab
                                    detail={detail}
                                    onChanged={onChanged}
                                    selectedStage={stageView ?? undefined}
                                    onSelectStage={setStageView}
                                />
                            ) : tab === "literature" ? (
                                <LiteratureTab projectId={detail.project.id} onChanged={onChanged} />
                            ) : tab === "writing" ? (
                                <WritingTab projectId={detail.project.id} />
                            ) : tab === "experiments" ? (
                                <ExperimentsTab
                                    projectId={detail.project.id}
                                    onChanged={() => void onChanged()}
                                />
                            ) : tab === "evidence" ? (
                                <EvidenceTab projectId={detail.project.id} />
                            ) : tab === "validation" ? (
                                <ValidationTab projectId={detail.project.id} />
                            ) : tab === "analysis" ? (
                                <AnalysisTab projectId={detail.project.id} />
                            ) : tab === "workspace" ? (
                                <WorkspaceTab
                                    projectId={detail.project.id}
                                    onChanged={() => void onChanged()}
                                />
                            ) : tab === "plans" ? (
                                <PlansTab projectId={detail.project.id} />
                            ) : tab === "approvals" ? (
                                <ApprovalTab
                                    projectId={detail.project.id}
                                    onChanged={() => void onChanged()}
                                />
                            ) : (
                                <EventsTab projectId={detail.project.id} />
                            )}
                        </Box>
                    </Box>
                </Box>

                <ConfirmDialog
                    open={archiveOpen}
                    title="移入回收站？"
                    message={`「${project?.title ?? "当前项目"}」会移到回收站，可随时恢复。`}
                    confirmLabel="移入回收站"
                    danger
                    busy={refreshing}
                    onCancel={() => setArchiveOpen(false)}
                    onConfirm={() => {
                        setArchiveOpen(false);
                        void archiveSelected();
                    }}
                />

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
            </Box>
        </GoogleResearchTheme>
    );
}
