/**
 * 科研工作台：桌面端内部子视图（Google Workspace 视觉体系）。
 *
 * 全屏两栏工作区：左侧研究项目栏（搜索 + 列表 + AI 绑定状态），右侧项目页
 * （项目头 + M3 主 tab + 卡片内容区）。样式全部收敛在 ./research/research.css
 * 的 .research-scope 作用域内（浅色 / 深色均按 Google 令牌取值），不改动
 * 应用其余域的视觉。数据与交互逻辑保持不变。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  PAPER_KIND_LABELS, RESEARCH_EVENTS_PAGE_SIZE, RESEARCH_STAGES, STAGE_ADVICE,
  STAGE_LABELS, STAGE_STATUS_LABELS,
  addResearchArtifact, askResearch, createResearchProject, generateResearchPlan,
  getLatestResearchAdvice, getResearchOverviewStats, getResearchPlan, getResearchProject,
  listResearchAdvice, listResearchEvents, listResearchProjects, nextStage,
  recommendResearchVenues, setResearchPlanTask, updateResearchProject, updateResearchStage,
  type ProjectDetail, type ResearchAdvice, type ResearchEvent, type ResearchOverviewStats,
  type ResearchPlan, type ResearchProject, type VenueSuggestion,
} from "../lib/research";
import { actorLabel, describeEvent, mergeEvents } from "./research/activity";
import DataTab from "./research/DataTab";
import FileTab from "./research/FileTab";
import LiteratureTab from "./research/LiteratureTab";
import WritingTab from "./research/WritingTab";
import {
  autoGrowTextarea, copyToClipboard, errorText, formatActivityTime, formatDate, formatDateTime,
} from "./research/common";
import {
  parseStageChecks, serializeStageChecks, stagePlan, stagePlanMarkdown, type StagePlan,
} from "./research/stagePlan";
import { HOME_HASH, navigate } from "../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../lib/chat";
import {
  getActiveResearchProjectId,
  setActiveResearchProject,
  setPendingResearchPrompt,
  setResearchNewChatFlag,
  subscribeResearchDataChange,
} from "../lib/research-context";
import { ChevronLeftGlyph, ChevronRightGlyph, SearchGlyph } from "./icons";
import { useToast } from "../lib/toast";
import "./research/research.css";
import "./research/research-inputs.css";

type ResearchTab = "overview" | "literature" | "data" | "writing" | "files";
const TABS: Array<{ id: ResearchTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "literature", label: "文献" },
  { id: "data", label: "数据" },
  { id: "writing", label: "写作" },
  { id: "files", label: "文件" },
];
function stageClass(status: string): string {
  switch (status) {
    case "approved": case "frozen": return "is-done";
    case "active": return "is-active";
    case "submitted": return "is-submitted";
    case "rework": return "is-rework";
    default: return "";
  }
}
/** 最近动态的 dot 语义色：user / agent / chat 各一色，其余走默认主色。 */
function activityDotClass(actor: string): string {
  switch (actor) {
    case "user": return "rs-activity__dot rs-activity__dot--user";
    case "agent": return "rs-activity__dot rs-activity__dot--agent";
    case "chat": return "rs-activity__dot rs-activity__dot--chat";
    default: return "rs-activity__dot";
  }
}
function artifactStatus(status: string): string {
  switch (status) {
    case "confirmed": return "已确认";
    case "frozen": return "已冻结";
    case "superseded": return "已取代";
    default: return "草稿";
  }
}
const KINDS = [
  { value: "journal", label: "期刊论文（默认）" },
  { value: "conference", label: "会议论文" },
  { value: "thesis_master", label: "硕士学位论文" },
  { value: "thesis_phd", label: "博士学位论文" },
  { value: "course", label: "课程论文" },
  { value: "grant", label: "基金申报书" },
];
const ARTIFACT_KINDS = [
  { value: "doc", label: "文档" }, { value: "outline", label: "大纲" },
  { value: "table", label: "结果表" }, { value: "figure", label: "图" },
  { value: "dataset", label: "数据集" }, { value: "run", label: "实验记录" },
];

/** 「研究计划」渲染用的计划视图（AI 计划与静态模板的公共字段）。 */
type PlanView = Pick<StagePlan, "goal" | "tasks" | "deliverables" | "acceptance" | "risks" | "prompts">;

/** 左侧项目栏折叠状态的 localStorage key（跨会话记忆）。 */
const RAIL_COLLAPSED_KEY = "mb.research.rail.collapsed";

/** 初始折叠状态：窄屏（<1024）默认折叠；否则读 localStorage，默认展开。 */
function initialRailCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(max-width: 1024px)").matches) return true;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Google 风格 Material glyph（fill 型，随 currentColor）。 */
function FlaskIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 3h6v2h-1v5.1l4.6 8.1A2.4 2.4 0 0 1 16.5 22h-9a2.4 2.4 0 0 1-2.1-3.8L10 10.1V5H9V3zm3 2v5.5L7.7 18h8.6L12 10.5V5z" />
    </svg>
  );
}
function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
    </svg>
  );
}
function RefreshIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

export default function ResearchView(): React.JSX.Element {
  const toast = useToast();
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [eventsLoadingMore, setEventsLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<ResearchTab>("overview");
  const [query, setQuery] = useState("");
  const [writingDirty, setWritingDirty] = useState(false);
  // 左侧项目栏折叠（localStorage 记忆；窄屏默认折叠，展开为覆盖式抽屉）。
  const [railCollapsed, setRailCollapsed] = useState<boolean>(initialRailCollapsed);
  const [form, setForm] = useState({ title: "", paperKind: "journal", targetVenue: "", deadline: "" });
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactKind, setArtifactKind] = useState("doc");
  // 控制台内联 AI 助手：最新建议 + 建议历史 + 提问草稿 + 运行态。
  const [latestAdvice, setLatestAdvice] = useState<ResearchAdvice | null>(null);
  const [advices, setAdvices] = useState<ResearchAdvice[]>([]);
  const [askDraft, setAskDraft] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  // 阶段化概览：「研究计划」预览阶段 / 本阶段资料计数 / 勾选保存状态 / 复制提示。
  const [overview, setOverview] = useState<ResearchOverviewStats | null>(null);
  const [planStage, setPlanStage] = useState<string | null>(null);
  const [planSaving, setPlanSaving] = useState(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  // 目标期刊 AI 推荐：候选面板 / 加载态 / 采纳中。
  const [venueOpen, setVenueOpen] = useState(false);
  const [venueBusy, setVenueBusy] = useState(false);
  const [venueSuggestions, setVenueSuggestions] = useState<VenueSuggestion[]>([]);
  const [venueAdopting, setVenueAdopting] = useState<string | null>(null);
  // AI 研究计划：预览阶段优先用后端持久化的 AI 计划，否则回退静态模板。
  const [aiPlan, setAiPlan] = useState<ResearchPlan | null>(null);
  const [planGenerating, setPlanGenerating] = useState(false);
  // 最近动态滚动容器（滚到底自动追加下一页）。
  const activityWrapRef = useRef<HTMLDivElement | null>(null);
  // 聊天里的学术工具改动数据后，强制重挂当前 tab 拉取最新内容。
  const [dataVersion, setDataVersion] = useState(0);
  const [askError, setAskError] = useState<string | null>(null);
  // 项目信息内联编辑（标题 / 论文类型 / 领域 / 目标期刊 / 截止日期）。
  const [editingInfo, setEditingInfo] = useState(false);
  const [infoDraft, setInfoDraft] = useState({
    title: "",
    paperKind: "journal",
    field: "",
    targetVenue: "",
    deadline: "",
  });

  async function loadProjects(preferId?: string): Promise<void> {
    try {
      const rows = await listResearchProjects();
      setProjects(rows);
      const activeId = getActiveResearchProjectId();
      const preferred = activeId !== null && rows.some((row) => row.id === activeId) ? activeId : null;
      const nextId = preferId ?? preferred ?? selectedId ?? rows[0]?.id ?? null;
      setSelectedId(nextId);
      if (nextId !== null) await loadDetail(nextId);
      else { setDetail(null); setEvents([]); }
    } catch (err) { setError(errorText(err)); }
    finally { setLoading(false); }
  }
  /** 重新拉第一页动态（切项目 / 刷新 / 新增产物 / 提问后都会回到第一页）。 */
  async function reloadEvents(projectId: string): Promise<void> {
    const page = await listResearchEvents(projectId);
    setEvents(page.events);
    setEventsHasMore(page.hasMore);
  }
  /** 用最后一条事件的 id 作游标，向更早的一页追加。 */
  async function loadMoreEvents(): Promise<void> {
    if (eventsLoadingMore || !eventsHasMore) return;
    const projectId = detail?.project.id;
    const last = events[events.length - 1];
    if (projectId === undefined || last === undefined) return;
    setEventsLoadingMore(true);
    setError(null);
    try {
      const page = await listResearchEvents(projectId, { beforeId: last.id });
      // 期间若列表被重置（切项目 / 刷新），尾条已变，丢弃这一页避免拼接错位。
      setEvents((prev) => {
        const tail = prev[prev.length - 1];
        if (tail === undefined || tail.id !== last.id) return prev;
        return [...prev, ...page.events];
      });
      setEventsHasMore(page.hasMore);
    } catch (err) { setError(errorText(err)); }
    finally { setEventsLoadingMore(false); }
  }
  async function loadDetail(projectId: string): Promise<void> {
    const next = await getResearchProject(projectId);
    setDetail(next);
    await reloadEvents(projectId);
    try {
      setLatestAdvice(await getLatestResearchAdvice(projectId));
    } catch {
      setLatestAdvice(null);
    }
    // 建议历史 / 资料计数失败不阻塞详情页（旧数据 / 后端未就绪时退化为空）。
    try {
      setAdvices(await listResearchAdvice(projectId));
    } catch {
      setAdvices([]);
    }
    try {
      setOverview(await getResearchOverviewStats(projectId));
    } catch {
      setOverview(null);
    }
  }
  useEffect(() => { void loadProjects(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return subscribeResearchDataChange(() => {
      setDataVersion((value) => value + 1);
      const id = getActiveResearchProjectId() ?? selectedId;
      if (id !== null) {
        void loadDetail(id).catch(() => undefined);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 项目栏折叠状态持久化；窗口缩到窄屏（<1024）时自动折叠为抽屉。
  useEffect(() => {
    try { window.localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
  }, [railCollapsed]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    function handleChange(event: MediaQueryListEvent): void {
      if (event.matches) setRailCollapsed(true);
    }
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  // 「研究计划」预览阶段默认跟随当前阶段；切项目 / 阶段推进后回到当前阶段。
  useEffect(() => {
    setPlanStage(detail === null ? null : detail.project.currentStage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.project.id, detail?.project.currentStage]);

  // 复制 Markdown 的成功提示 2s 后自动消失。
  useEffect(() => {
    if (planNotice === null) return;
    const timer = window.setTimeout(() => setPlanNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [planNotice]);

  const filtered = useMemo<ResearchProject[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === "") return projects;
    return projects.filter((row) => {
      const haystack = [row.title, row.targetVenue, row.field, STAGE_LABELS[row.currentStage] ?? ""].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [projects, query]);

  async function selectProject(projectId: string): Promise<void> {
    setSelectedId(projectId); setActiveResearchProject(projectId); setWritingDirty(false); setError(null); setNotice(null);
    try { await loadDetail(projectId); } catch (err) { setError(errorText(err)); }
  }
  async function selectTab(next: ResearchTab): Promise<void> {
    if (next === tab) return;
    if (tab === "writing" && writingDirty) {
      const confirmed = await confirm("「写作」页有未保存的章节改动，切换会丢弃这些改动。继续？", { title: "未保存的改动", kind: "warning" });
      if (!confirmed) return;
      setWritingDirty(false);
    }
    setTab(next);
    if (next === "overview" && selectedId !== null) {
      try { await loadDetail(selectedId); } catch (err) { setError(errorText(err)); }
    }
  }
  async function handleCreate(): Promise<void> {
    if (form.title.trim() === "") { setError("请填写项目名称"); return; }
    setBusy(true); setError(null);
    try {
      const created = await createResearchProject({
        title: form.title.trim(), paperKind: form.paperKind,
        targetVenue: form.targetVenue.trim(), deadline: form.deadline.trim(),
      });
      setShowCreate(false);
      setForm({ title: "", paperKind: "journal", targetVenue: "", deadline: "" });
      setActiveResearchProject(created.project.id);
      await loadProjects(created.project.id); setTab("overview");
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  async function handleStage(stage: string): Promise<void> {
    if (detail === null || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await updateResearchStage(detail.project.id, stage, "active");
      setDetail(next); await loadProjects(detail.project.id);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  /** 控制台内联提问：直接走 research_ask（ReAct + 工具），结果落库并回填。 */
  async function askInline(question?: string): Promise<void> {
    if (detail === null || askBusy) return;
    const prompt = (question ?? askDraft).trim();
    if (prompt === "") {
      setAskError("先写一句问题，或直接用「让助手分析当前阶段」");
      return;
    }
    setAskBusy(true);
    setAskError(null);
    try {
      const answer = await askResearch(detail.project.id, prompt);
      setLatestAdvice({ question: prompt, notes: answer, createdAt: Math.floor(Date.now() / 1000) });
      setAskDraft("");
      await reloadEvents(detail.project.id);
      // 新建议落库后刷新建议历史与资料计数。
      try { setAdvices(await listResearchAdvice(detail.project.id)); } catch { /* 历史刷新失败不阻塞 */ }
      try { setOverview(await getResearchOverviewStats(detail.project.id)); } catch { /* 计数刷新失败不阻塞 */ }
    } catch (err) {
      setAskError(errorText(err));
    } finally {
      setAskBusy(false);
    }
  }

  async function handleAddArtifact(): Promise<void> {
    if (detail === null) return;
    const title = artifactTitle.trim();
    if (title === "") { setError("请填写产物标题"); return; }
    setBusy(true); setError(null);
    try {
      const next = await addResearchArtifact(detail.project.id, { stage: detail.project.currentStage, kind: artifactKind, title });
      setDetail(next); setArtifactTitle("");
      await reloadEvents(detail.project.id);
      await loadProjects(detail.project.id);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  /** 勾选 / 取消一条计划任务：乐观更新 gateJson，再回填 research_plan_task_set 返回的详情。 */
  async function togglePlanTask(taskId: string, checked: boolean): Promise<void> {
    if (detail === null || previewStageRow === null || planSaving || busy) return;
    const projectId = detail.project.id;
    const nextChecks: Record<string, boolean> = { ...parseStageChecks(previewStageRow.gateJson) };
    if (checked) nextChecks[taskId] = true;
    else delete nextChecks[taskId];
    const gateJson = serializeStageChecks(nextChecks);
    const previous = detail;
    setPlanSaving(true);
    setDetail((prev) => prev === null ? prev : {
      ...prev,
      stages: prev.stages.map((row) => row.stage === previewStage ? { ...row, gateJson } : row),
    });
    try {
      setDetail(await setResearchPlanTask(projectId, previewStage, taskId, checked));
    } catch (err) {
      setError(errorText(err));
      setDetail(previous);
      try { await loadDetail(projectId); } catch { /* 回滚后的刷新失败不重复报错 */ }
    } finally {
      setPlanSaving(false);
    }
  }

  /** 把预览阶段设为进行中（与「研究阶段」卡片的点击行为一致）。 */
  async function promotePlanStage(): Promise<void> {
    if (detail === null || plan === null) return;
    const target = previewStage;
    await handleStage(target);
    setPlanStage(target);
  }

  /** 当前阶段完成并进入下一阶段：未勾满关键任务时先确认。 */
  async function completeStageAndAdvance(): Promise<void> {
    if (detail === null || busy) return;
    const current = detail.project.currentStage;
    const next = nextStage(current);
    if (next === null) return;
    const remaining = Math.max(0, planProgress.total - planProgress.done);
    if (remaining > 0) {
      const confirmed = await confirm(`还有 ${remaining} 项关键任务未完成，仍要推进吗？`, { title: "推进阶段", kind: "warning" });
      if (!confirmed) return;
    }
    setBusy(true); setError(null);
    try {
      await updateResearchStage(detail.project.id, current, "approved");
      await updateResearchStage(detail.project.id, next, "active");
      await loadProjects(detail.project.id);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  /** 复制当前预览阶段（AI 计划或模板）的 Markdown。 */
  async function copyPlan(): Promise<void> {
    if (project === null || plan === null) return;
    const exportPlan: StagePlan = { ...plan, related: [] };
    const ok = await copyToClipboard(stagePlanMarkdown(project.title, previewStageLabel, exportPlan, planChecks));
    if (ok) setPlanNotice("已复制 Markdown 到剪贴板");
    else setError("复制失败：当前环境剪贴板不可用");
  }

  /** AI 生成 / 重新生成当前预览阶段的研究计划。 */
  async function generatePlan(): Promise<void> {
    if (project === null || planGenerating) return;
    setPlanGenerating(true); setError(null);
    try {
      const generated = await generateResearchPlan(project.id, previewStage);
      setAiPlan(generated);
      setPlanNotice("已生成「" + previewStageLabel + "」阶段 AI 计划");
      toast.success("AI 计划已生成", { title: "研究计划" });
      void reloadEvents(project.id);
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "生成计划失败" });
    } finally {
      setPlanGenerating(false);
    }
  }

  /** 打开候选面板并调用 AI 推荐目标期刊。 */
  async function recommendVenues(): Promise<void> {
    if (project === null || venueBusy) return;
    setVenueOpen(true); setVenueBusy(true); setError(null);
    try {
      const list = await recommendResearchVenues(project.id);
      setVenueSuggestions(list);
      if (list.length === 0) setError("AI 没有返回候选期刊，可检查模型配置后重试");
      void reloadEvents(project.id);
    } catch (err) {
      setVenueSuggestions([]);
      setError(errorText(err));
    } finally {
      setVenueBusy(false);
    }
  }

  /** 采纳某个候选期刊：写回项目 targetVenue 并刷新详情。 */
  async function adoptVenue(item: VenueSuggestion): Promise<void> {
    if (project === null || venueAdopting !== null) return;
    setVenueAdopting(item.venue); setError(null);
    try {
      await updateResearchProject(project.id, { targetVenue: item.venue });
      await loadProjects(project.id);
      setVenueOpen(false);
      setNotice("目标期刊已更新为「" + item.venue + "」");
      toast.success("已采纳「" + item.venue + "」", { title: "目标期刊" });
    } catch (err) {
      setError(errorText(err));
      toast.error(errorText(err), { title: "采纳失败" });
    } finally {
      setVenueAdopting(null);
    }
  }

  /** 让主聊天里的研究 agent 逐项完成本阶段计划任务（用 plan_task_set 勾选）。 */
  function askAiToCompleteStage(): void {
    if (project === null || plan === null) return;
    const taskLines = plan.tasks.map((task) => {
      const doneMark = planChecks[task.id] === true ? "（已完成）" : "";
      return "- [id=" + task.id + "] " + task.label + doneMark;
    }).join("\n");
    const prompt = [
      "请帮我把科研项目「" + project.title + "」的「" + previewStageLabel + "」阶段推进到可验收：",
      "阶段目标：" + plan.goal,
      "当前计划任务（taskId 用于勾选）：",
      taskLines,
      "要求：逐项执行（可读写项目文件、检索/核验文献、跑分析、登记产物等）；每完成一项后用 academic_project(plan_task_set, project_id=\"" + project.id + "\", stage=\"" + previewStage + "\", task_id=对应 id, done=true) 勾选；最后汇报完成情况、仍缺的证据与下一步建议。",
    ].join("\n");
    openInChat(prompt);
  }

  /** 最近动态滚动到底部附近时自动追加下一页。 */
  function handleActivityScroll(): void {
    const container = activityWrapRef.current;
    if (container === null || !eventsHasMore || eventsLoadingMore) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 56) void loadMoreEvents();
  }

  function startEditInfo(): void {
    if (project === null) return;
    setInfoDraft({
      title: project.title,
      paperKind: project.paperKind,
      field: project.field,
      targetVenue: project.targetVenue,
      deadline: project.deadline,
    });
    setEditingInfo(true);
    setError(null);
  }

  async function saveInfo(): Promise<void> {
    if (project === null || busy) return;
    const title = infoDraft.title.trim();
    if (title === "") {
      setError("项目名称不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateResearchProject(project.id, {
        title,
        paperKind: infoDraft.paperKind,
        field: infoDraft.field.trim(),
        targetVenue: infoDraft.targetVenue.trim(),
        deadline: infoDraft.deadline.trim(),
      });
      setEditingInfo(false);
      await loadProjects(project.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const project = detail?.project ?? null;
  const stageRows = detail?.stages ?? RESEARCH_STAGES.map((stage) => ({ stage, status: "locked", label: STAGE_LABELS[stage] ?? stage }));
  const currentStageLabel = project === null ? "" : STAGE_LABELS[project.currentStage] ?? project.currentStage;
  const advice = project === null ? "" : STAGE_ADVICE[project.currentStage] ?? "先确认当前阶段的目标与已有产物，再推进下一步。";
  const kindLabel = project === null ? "" : PAPER_KIND_LABELS[project.paperKind] ?? project.paperKind;
  const boundToChat = project !== null && getActiveResearchProjectId() === project.id;
  const activity = useMemo(() => mergeEvents(events), [events]);

  // ---- 阶段化「研究计划」派生数据 ----
  const previewStage = planStage ?? project?.currentStage ?? RESEARCH_STAGES[0];
  const staticPlan = stagePlan(previewStage);
  const previewStageLabel = STAGE_LABELS[previewStage] ?? previewStage;
  const previewStageRow = detail?.stages.find((row) => row.stage === previewStage) ?? null;
  const planChecks = parseStageChecks(previewStageRow?.gateJson ?? "");
  /** 当前预览阶段已加载的 AI 计划（stage 不匹配时视为未加载）。 */
  const aiPlanForStage = aiPlan !== null && aiPlan.stage === previewStage ? aiPlan : null;
  /** 展示用计划：AI 计划优先，没有则回退静态模板。 */
  const plan: PlanView | null = aiPlanForStage ?? staticPlan;
  const isAiPlan = aiPlanForStage !== null;
  const planProgress = plan === null ? { done: 0, total: 0 } : {
    done: plan.tasks.filter((task) => planChecks[task.id] === true).length,
    total: plan.tasks.length,
  };
  const currentPlan = project === null ? null : stagePlan(project.currentStage);
  const nextStageId = project === null ? null : nextStage(project.currentStage);
  /** AI 建议列表：优先用历史，后端只有最新一条时退化为单条。 */
  const adviceItems = advices.length > 0 ? advices : latestAdvice === null ? [] : [latestAdvice];

  // 加载预览阶段的 AI 计划；后端未实现 / 未生成时静默回退静态模板。
  useEffect(() => {
    if (project === null) { setAiPlan(null); return; }
    let cancelled = false;
    setAiPlan(null);
    getResearchPlan(project.id, previewStage)
      .then((loaded) => { if (!cancelled) setAiPlan(loaded); })
      .catch(() => { if (!cancelled) setAiPlan(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, previewStage]);

  /** 所有 AI 对话都在主聊天进行：这里只绑定项目 + 可选草稿 + 跳转。 */
  function openInChat(prompt?: string): void {
    if (project === null) return;
    setActiveResearchProject(project.id);
    if (prompt !== undefined && prompt !== "") setPendingResearchPrompt(prompt);
    setResearchNewChatFlag();
    // 科研对话一律落在普通对话模式（避免沿用上次的简历/PPT 模式）。
    window.sessionStorage.setItem(CHAT_MODE_JUMP_KEY, "chat");
    navigate(HOME_HASH);
  }

  return (
    <div className="research-scope">
      {/* 顶栏：Google app bar */}
      <header className="rs-topbar">
        <div className="rs-topbar__brand">
          <span className="rs-topbar__logo" aria-hidden="true"><FlaskIcon /></span>
          <div className="rs-topbar__text">
            <h1 className="rs-topbar__title">科研工作台</h1>
            <p className="rs-topbar__sub">本地项目 · 数据不出本机</p>
          </div>
        </div>
        <div className="rs-topbar__actions">
          {project !== null && (
            <button
              type="button"
              className="icon-button"
              title="刷新项目"
              aria-label="刷新项目"
              onClick={() => void loadProjects(project.id)}
            >
              <RefreshIcon />
            </button>
          )}
          <button type="button" className="button button--primary" onClick={() => setShowCreate(true)}>
            <PlusIcon />
            新建项目
          </button>
        </div>
      </header>

      <div className="rs-body">
        {/* 左：研究项目栏（可折叠；折叠后保留悬浮展开按钮） */}
        {!railCollapsed && (
          <button
            type="button"
            className="rs-rail-scrim"
            aria-label="收起项目栏"
            onClick={() => setRailCollapsed(true)}
          />
        )}
        <aside className={railCollapsed ? "rs-rail rs-rail--collapsed" : "rs-rail"} aria-label="研究项目">
          <label className="rs-search">
            <SearchGlyph />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目、期刊或阶段"
              aria-label="搜索研究项目"
            />
            {query !== "" && (
              <button
                type="button"
                className="rs-search__clear"
                aria-label="清除搜索"
                title="清除搜索"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </label>

          <div className="rs-rail__head">
            <span>研究项目</span>
            <span className="spacer" />
            <span className="rs-rail__count">{projects.length}</span>
            <button
              type="button"
              className="icon-button rs-rail__collapse"
              title="收起项目栏"
              aria-label="收起项目栏"
              onClick={() => setRailCollapsed(true)}
            >
              <ChevronLeftGlyph />
            </button>
          </div>

          <nav className="rs-projects">
            {loading ? (
              <p className="rs-rail__note">加载项目…</p>
            ) : filtered.length === 0 ? (
              <p className="rs-rail__note">
                {query === "" ? "还没有研究项目，点右上角「新建项目」开始。" : "没有匹配的项目。"}
              </p>
            ) : (
              filtered.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={row.id === selectedId ? "research-project is-active" : "research-project"}
                  aria-current={row.id === selectedId ? "true" : undefined}
                  onClick={() => void selectProject(row.id)}
                >
                  <div className="research-project__title">{row.title}</div>
                  <div className="research-project__meta">
                    {PAPER_KIND_LABELS[row.paperKind] ?? row.paperKind} · {STAGE_LABELS[row.currentStage] ?? row.currentStage}
                  </div>
                </button>
              ))
            )}
          </nav>

          {project !== null && (
            <div className="rs-rail__ai">
              <p className="rs-rail__ai-title">AI 对话</p>
              <p className="rs-rail__ai-text">对话在主聊天进行；控制台只同步项目与阶段状态。</p>
              <div className="research-row">
                <span className={boundToChat ? "status status--ok" : "status"}>
                  {boundToChat ? "主对话已绑定本项目" : "主对话未绑定"}
                </span>
                <button type="button" className="button research-btn-sm" onClick={() => openInChat()}>
                  去讨论
                </button>
              </div>
            </div>
          )}

          <p className="rs-rail__foot">数据仅保存在本机研究目录</p>
        </aside>

        {railCollapsed && (
          <button
            type="button"
            className="rs-rail-reopen"
            title="展开项目栏"
            aria-label="展开项目栏"
            onClick={() => setRailCollapsed(false)}
          >
            <ChevronRightGlyph />
            <span className="rs-rail-reopen__text">项目</span>
          </button>
        )}

        {/* 右：项目页 */}
        <main className="rs-main">
          {error !== null && (
            <p className="error-text rs-banner" onClick={() => setError(null)} title="点击关闭">
              {error}
            </p>
          )}
          {notice !== null && (
            <p className="hint-text rs-banner" onClick={() => setNotice(null)} title="点击关闭">
              {notice}
            </p>
          )}

          {project === null ? (
            <div className="rs-empty">
              <span className="rs-empty__icon" aria-hidden="true"><FlaskIcon /></span>
              <h2 className="rs-empty__title">{loading ? "正在载入研究项目…" : "开始你的第一个研究项目"}</h2>
              <p className="rs-empty__text">
                工作台按投稿流程记录六个阶段、文献证据、数据画像与章节稿件；AI 讨论在主聊天进行，
                这里负责把项目推进到下一个可验收的产物。
              </p>
              {!loading && (
                <div className="rs-empty__actions">
                  <button type="button" className="button button--primary" onClick={() => setShowCreate(true)}>
                    <PlusIcon />
                    新建研究项目
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="rs-projecthead">
                <div className="rs-projecthead__text">
                  <p className="rs-breadcrumb">研究项目 · {currentStageLabel}</p>
                  <h2 className="rs-projecttitle">{project.title}</h2>
                  <div className="rs-chips">
                    <span className="rs-chip rs-chip--primary">当前 {currentStageLabel}</span>
                    <span className="rs-chip">{kindLabel}</span>
                    {project.targetVenue !== "" && <span className="rs-chip">目标 {project.targetVenue}</span>}
                    {project.deadline !== "" && <span className="rs-chip">截止 {project.deadline}</span>}
                    <span className="rs-chip">{project.privacy === "local" ? "仅本地" : project.privacy}</span>
                    <span className="rs-chip rs-chip--plain">更新于 {formatDate(project.updatedAt)}</span>
                  </div>
                </div>
                <div className="rs-projecthead__actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => openInChat("请结合当前科研项目的阶段、产物、文献与数据，给出这个阶段的下一步建议与主要风险。")}
                  >
                    在主对话中讨论
                  </button>
                </div>
              </div>

              <nav className="rs-tabs" role="tablist" aria-label="科研项目详情">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={item.id === tab}
                    className={item.id === tab ? "rs-tab rs-tab--active" : "rs-tab"}
                    onClick={() => void selectTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>

              <div className={tab === "writing" || tab === "files" ? "rs-content rs-content--fill" : "rs-content"} key={dataVersion}>
                {tab === "overview" && (
                  <div className="rs-pane">
                    <section className="card">
                      <div className="research-section-head">
                        <h3>研究阶段</h3>
                        <span className="hint-text">点击阶段查看计划；在「研究计划」里设为进行中或推进</span>
                      </div>
                      <div className="research-stages">
                        {stageRows.map((row, index) => {
                          const isCurrent = project !== null && row.stage === project.currentStage;
                          const isSelected = row.stage === previewStage;
                          return (
                            <button
                              key={row.stage}
                              type="button"
                              className={"research-stage " + stageClass(row.status) + (isSelected ? " is-selected" : "")}
                              aria-pressed={isSelected}
                              onClick={() => setPlanStage(row.stage)}
                              title={"查看该阶段计划：" + (row.label ?? STAGE_LABELS[row.stage] ?? row.stage)}
                            >
                              <span className="research-stage__dot">
                                {row.status === "approved" || row.status === "frozen" ? "✓" : index + 1}
                              </span>
                              <span className="research-stage__label">
                                {row.label ?? STAGE_LABELS[row.stage] ?? row.stage}
                                {isCurrent && <span className="rs-plan__badge">当前</span>}
                              </span>
                              <span className="research-stage__status">{STAGE_STATUS_LABELS[row.status] ?? row.status}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="card rs-plan">
                      <div className="research-section-head">
                        <h3>研究计划</h3>
                        <span
                          className={isAiPlan ? "rs-plan__source is-ai" : "rs-plan__source"}
                          title={aiPlanForStage !== null ? "AI 生成于 " + formatDateTime(aiPlanForStage.generatedAt) : "静态模板（可用 AI 生成）"}
                        >
                          {isAiPlan ? "AI 计划" : "模板"}
                        </span>
                        <span className="hint-text">{previewStageLabel} · 进度 {planProgress.done}/{planProgress.total}</span>
                        {planNotice !== null && <span className="rs-plan__notice">{planNotice}</span>}
                        <span className="spacer" />
                        <button
                          type="button"
                          className="button research-btn-sm"
                          disabled={plan === null}
                          onClick={() => void copyPlan()}
                        >
                          复制 Markdown
                        </button>
                        <button
                          type="button"
                          className="button research-btn-sm"
                          disabled={planGenerating || project === null}
                          onClick={() => void generatePlan()}
                        >
                          {planGenerating ? "生成中…" : isAiPlan ? "重新生成" : "AI 生成计划"}
                        </button>
                      </div>

                      {plan === null ? (
                        <p className="hint-text">该阶段还没有计划模板。</p>
                      ) : (
                        <>
                          <p className="rs-plan__goal">{plan.goal}</p>

                          <div className="rs-plan__checks">
                            {plan.tasks.map((task) => (
                              <label key={task.id} className="rs-plan__check">
                                <input
                                  type="checkbox"
                                  checked={planChecks[task.id] === true}
                                  disabled={planSaving || busy}
                                  onChange={(event) => void togglePlanTask(task.id, event.target.checked)}
                                />
                                <span>{task.label}</span>
                              </label>
                            ))}
                          </div>

                          <div className="rs-plan__cols">
                            {[
                              { title: "交付物", items: plan.deliverables },
                              { title: "验收标准", items: plan.acceptance },
                              { title: "常见风险", items: plan.risks },
                            ].map((group) => (
                              <div key={group.title} className="rs-plan__col">
                                <h4>{group.title}</h4>
                                <ul>
                                  {group.items.map((item) => <li key={item}>{item}</li>)}
                                </ul>
                              </div>
                            ))}
                          </div>

                          <div className="rs-plan__stats">
                            <span className="rs-plan__stats-label">本阶段资料</span>
                            {overview === null ? (
                              <span className="rs-plan__stat rs-plan__stat--plain">统计加载中…</span>
                            ) : (
                              <>
                                <button type="button" className="rs-plan__stat" onClick={() => void selectTab("literature")}>
                                  文献 {overview.literatureTotal}（已核实 {overview.literatureVerified}）
                                </button>
                                <button type="button" className="rs-plan__stat" onClick={() => void selectTab("data")}>
                                  数据集 {overview.datasets}
                                </button>
                                <button type="button" className="rs-plan__stat" onClick={() => void selectTab("data")}>
                                  实验 {overview.experiments}
                                </button>
                                <button type="button" className="rs-plan__stat" onClick={() => void selectTab("writing")}>
                                  章节 {overview.manuscriptSections}（{overview.manuscriptWords} 字）
                                </button>
                                <span className="rs-plan__stat rs-plan__stat--plain">
                                  产物 {overview.artifacts} · 建议 {overview.adviceCount}
                                </span>
                              </>
                            )}
                          </div>

                          <div className="rs-plan__actions">
                            <button
                              type="button"
                              className="button research-btn-sm"
                              disabled={project === null}
                              onClick={askAiToCompleteStage}
                            >
                              让 AI 完成本阶段
                            </button>
                            {project !== null && previewStage !== project.currentStage ? (
                              <button
                                type="button"
                                className="button research-btn-sm"
                                disabled={busy}
                                onClick={() => void promotePlanStage()}
                              >
                                把「{previewStageLabel}」设为进行中
                              </button>
                            ) : nextStageId === null ? (
                              <span className="hint-text">已是最后阶段</span>
                            ) : (
                              <button
                                type="button"
                                className="button button--primary research-btn-sm"
                                disabled={busy}
                                onClick={() => void completeStageAndAdvance()}
                              >
                                完成本阶段并进入下一阶段
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </section>

                    <div className="research-grid2">
                      <section className="card">
                        <div className="research-section-head">
                          <h3>AI 建议</h3>
                          <span className="rs-chip rs-chip--primary">{currentStageLabel}</span>
                          <span className="spacer" />
                          <span className="hint-text">
                            {adviceItems.length > 0 ? "最近 " + Math.min(adviceItems.length, 5) + " 条" : "暂无保存的建议"}
                          </span>
                        </div>
                        {adviceItems.length === 0 ? (
                          <p className="hint-text rs-advice__text">{advice}</p>
                        ) : (
                          <div className="rs-advice__list">
                            {adviceItems.slice(0, 5).map((item, index) => (
                              <details key={item.createdAt + "-" + index} className="rs-advice__item">
                                <summary className="rs-advice__summary">
                                  {(item.question === "" ? "阶段建议" : item.question) + " · " + formatDateTime(item.createdAt)}
                                </summary>
                                <p className="rs-advice__body">{item.notes}</p>
                              </details>
                            ))}
                          </div>
                        )}
                        {currentPlan !== null && currentPlan.prompts.length > 0 && (
                          <div className="rs-advice__prompts">
                            <span className="rs-advice__prompts-label">本阶段快捷提问</span>
                            {currentPlan.prompts.map((prompt) => (
                              <button
                                key={prompt}
                                type="button"
                                className="button research-btn-sm rs-advice__prompt"
                                disabled={askBusy}
                                onClick={() => void askInline(prompt)}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="rs-advice__ask">
                          <textarea
                            className="rs-advice__input is-autogrow"
                            rows={2}
                            value={askDraft}
                            placeholder="问助手：这个阶段下一步做什么？还缺哪些证据？（Enter 发送，Shift+Enter 换行）"
                            disabled={askBusy}
                            onChange={(event) => setAskDraft(event.target.value)}
                            onInput={(event) => autoGrowTextarea(event.currentTarget)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void askInline();
                              }
                            }}
                          />
                          <div className="rs-advice__actions">
                            <button
                              type="button"
                              className="button button--primary research-btn-sm"
                              disabled={askBusy}
                              onClick={() => void askInline()}
                            >
                              {askBusy ? "分析中…" : "让助手分析"}
                            </button>
                          </div>
                          {askError !== null && <p className="error-text rs-advice__error">{askError}</p>}
                        </div>
                      </section>

                      <section className="card">
                        <div className="research-section-head">
                          <h3>项目信息</h3>
                          <span className="spacer" />
                          {editingInfo ? (
                            <>
                              <button
                                type="button"
                                className="button research-btn-sm"
                                disabled={busy}
                                onClick={() => setEditingInfo(false)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="button button--primary research-btn-sm"
                                disabled={busy}
                                onClick={() => void saveInfo()}
                              >
                                {busy ? "保存中…" : "保存"}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="button research-btn-sm"
                              onClick={startEditInfo}
                            >
                              编辑
                            </button>
                          )}
                        </div>
                        {editingInfo ? (
                          <div className="rs-info-edit">
                            <div className="research-field">
                              <label htmlFor="rs-info-title">项目名称</label>
                              <input
                                id="rs-info-title"
                                className="text-input"
                                value={infoDraft.title}
                                disabled={busy}
                                onChange={(event) =>
                                  setInfoDraft((prev) => ({ ...prev, title: event.target.value }))
                                }
                              />
                            </div>
                            <div className="research-field">
                              <label htmlFor="rs-info-kind">论文类型</label>
                              <select
                                id="rs-info-kind"
                                className="research-select"
                                value={infoDraft.paperKind}
                                disabled={busy}
                                onChange={(event) =>
                                  setInfoDraft((prev) => ({ ...prev, paperKind: event.target.value }))
                                }
                              >
                                {KINDS.map((kind) => (
                                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="research-field">
                              <label htmlFor="rs-info-field">研究领域</label>
                              <input
                                id="rs-info-field"
                                className="text-input"
                                placeholder="例如：联邦学习 / RAG"
                                value={infoDraft.field}
                                disabled={busy}
                                onChange={(event) =>
                                  setInfoDraft((prev) => ({ ...prev, field: event.target.value }))
                                }
                              />
                            </div>
                            <div className="research-field">
                              <label htmlFor="rs-info-venue">目标期刊 / venue</label>
                              <input
                                id="rs-info-venue"
                                className="text-input"
                                placeholder="例如：IEEE TNNLS / 中文核心"
                                value={infoDraft.targetVenue}
                                disabled={busy}
                                onChange={(event) =>
                                  setInfoDraft((prev) => ({ ...prev, targetVenue: event.target.value }))
                                }
                              />
                            </div>
                            <div className="research-field">
                              <label htmlFor="rs-info-deadline">截止日期</label>
                              <input
                                id="rs-info-deadline"
                                className="text-input"
                                type="date"
                                title="截止日期"
                                value={infoDraft.deadline}
                                disabled={busy}
                                onChange={(event) =>
                                  setInfoDraft((prev) => ({ ...prev, deadline: event.target.value }))
                                }
                              />
                            </div>
                            <div className="research-field">
                              <label>数据边界</label>
                              <input
                                className="text-input"
                                value={project.privacy === "local" ? "仅本地" : project.privacy}
                                disabled
                              />
                            </div>
                            <span className="rs-info-edit__hint">
                              创建于 {formatDate(project.createdAt)} · 保存后项目标题与阶段面板同步更新
                            </span>
                          </div>
                        ) : (
                          <dl className="rs-kv">
                            <div><dt>论文类型</dt><dd>{kindLabel}</dd></div>
                            <div><dt>研究领域</dt><dd>{project.field === "" ? "未填写" : project.field}</dd></div>
                            <div>
                              <dt>目标期刊</dt>
                              <dd className="rs-venue">
                                <span className={project.targetVenue === "" ? "rs-venue__value is-empty" : "rs-venue__value"}>
                                  {project.targetVenue === "" ? "待 AI 推荐" : project.targetVenue}
                                </span>
                                <button
                                  type="button"
                                  className="button research-btn-sm"
                                  disabled={venueBusy}
                                  onClick={() => void recommendVenues()}
                                >
                                  {venueBusy ? "推荐中…" : "AI 推荐期刊"}
                                </button>
                              </dd>
                            </div>
                            <div><dt>截止日期</dt><dd>{project.deadline === "" ? "未填写" : project.deadline}</dd></div>
                            <div><dt>数据边界</dt><dd>{project.privacy === "local" ? "仅本地" : project.privacy}</dd></div>
                            <div><dt>创建时间</dt><dd>{formatDate(project.createdAt)}</dd></div>
                          </dl>
                        )}
                      </section>
                    </div>

                    <div className="research-grid2">
                      <section className="card">
                        <div className="research-section-head">
                          <h3>阶段产物</h3>
                          <span className="hint-text">{(detail?.artifacts.length ?? 0) + " 个"}</span>
                        </div>
                        <div className="research-row" style={{ marginBottom: 12 }}>
                          <input
                            className="text-input"
                            placeholder="登记产物：选题说明 / 数据画像 / 实验结果表…"
                            value={artifactTitle}
                            onChange={(event) => setArtifactTitle(event.target.value)}
                            onKeyDown={(event) => { if (event.key === "Enter") void handleAddArtifact(); }}
                          />
                          <select className="research-select" value={artifactKind} onChange={(event) => setArtifactKind(event.target.value)}>
                            {ARTIFACT_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                          </select>
                          <button type="button" className="button research-btn-sm" disabled={busy} onClick={() => void handleAddArtifact()}>登记</button>
                        </div>
                        {(detail?.artifacts.length ?? 0) === 0 ? (
                          <div className="research-empty"><p>还没有产物。每个阶段至少留一个可验收的产物（选题说明 / 研究设计 / 数据画像 / 稿件）。</p></div>
                        ) : (
                          <div className="rs-table-wrap"><table className="research-table">
                            <thead><tr><th>产物</th><th>阶段</th><th>类型</th><th>版本</th><th>状态</th></tr></thead>
                            <tbody>
                              {(detail?.artifacts ?? []).map((row) => (
                                <tr key={row.id}>
                                  <td>
                                    <div className="research-table__title">{row.title}</div>
                                    {row.path !== "" && <div className="research-table__meta">{row.path}</div>}
                                  </td>
                                  <td>{STAGE_LABELS[row.stage] ?? row.stage}</td>
                                  <td>{row.kind}</td>
                                  <td>v{row.version}</td>
                                  <td>{artifactStatus(row.status)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table></div>
                        )}
                      </section>

                      <section className="card">
                        <div className="research-section-head">
                          <h3>最近动态</h3>
                          <span className="hint-text">只追加，不改写 · 已加载 {activity.length} 条动态</span>
                        </div>
                        {events.length === 0 ? (
                          <div className="research-empty"><p>暂无动态。创建项目、导入文献、上传数据集后，这里会留下记录。</p></div>
                        ) : (
                          <div
                            className="rs-activity-wrap"
                            ref={activityWrapRef}
                            onScroll={handleActivityScroll}
                          >
                            <ul className="rs-activity">
                              {activity.map((item) => {
                                const described = describeEvent(item.event);
                                return (
                                  <li key={item.key}>
                                    <span className={activityDotClass(item.event.actor)} aria-hidden="true" />
                                    <span className="rs-activity__body">
                                      <span className="rs-activity__kind">
                                        {described.title}
                                        {item.count > 1 && <span className="rs-activity__count">×{item.count}</span>}
                                      </span>
                                      {described.detail !== "" && (
                                        <span className="rs-activity__detail">{described.detail}</span>
                                      )}
                                      <span className="rs-activity__meta">
                                        {formatActivityTime(item.event.ts, item.event.firstTs)} · {actorLabel(item.event.actor)}
                                      </span>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                            {eventsHasMore ? (
                              eventsLoadingMore ? <p className="rs-activity__foot">加载中…</p> : null
                            ) : events.length > RESEARCH_EVENTS_PAGE_SIZE ? (
                              <p className="rs-activity__foot">已到最早一条</p>
                            ) : null}
                          </div>
                        )}
                      </section>
                    </div>
                  </div>
                )}

                {tab === "literature" && <LiteratureTab key={project.id} projectId={project.id} />}
                {tab === "data" && <DataTab key={project.id} projectId={project.id} />}
                {tab === "writing" && <WritingTab key={project.id} projectId={project.id} onDirtyChange={setWritingDirty} />}
                {tab === "files" && <FileTab key={project.id} projectId={project.id} />}
              </div>
            </>
          )}
        </main>
      </div>

      {venueOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setVenueOpen(false); }}
        >
          <div className="modal rs-venue-modal" role="dialog" aria-modal="true" aria-labelledby="rs-venue-title">
            <div className="modal__head">
              <h3 className="modal__title" id="rs-venue-title">AI 推荐期刊</h3>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setVenueOpen(false)}>×</button>
            </div>
            <p className="hint-text">基于项目标题、论文类型、研究领域与近三年文献的投稿方向推荐；采纳后写入「目标期刊」，可随时手动改回。</p>

            {venueBusy ? (
              <p className="hint-text rs-venue-modal__loading">正在调用对话模型推荐期刊…（可能需要十几秒）</p>
            ) : venueSuggestions.length === 0 ? (
              <p className="hint-text rs-venue-modal__loading">暂无候选期刊；可检查模型配置后重新推荐。</p>
            ) : (
              <ul className="rs-venue-list">
                {venueSuggestions.map((item) => {
                  const score = Number.isFinite(item.matchScore) ? Math.max(0, Math.min(100, Math.round(item.matchScore))) : null;
                  const scoreClass = score === null ? "rs-venue__score" : score >= 80 ? "rs-venue__score is-high" : score >= 60 ? "rs-venue__score is-mid" : "rs-venue__score";
                  return (
                    <li key={item.venue} className="rs-venue-item">
                      <div className="rs-venue-item__head">
                        <span className="rs-venue-item__name">{item.venue}</span>
                        {score !== null && <span className={scoreClass}>{score}% 匹配</span>}
                        <span className="spacer" />
                        <button
                          type="button"
                          className="button research-btn-sm"
                          disabled={venueAdopting !== null}
                          onClick={() => void adoptVenue(item)}
                        >
                          {venueAdopting === item.venue ? "采纳中…" : "采纳"}
                        </button>
                      </div>
                      <p className="rs-venue-item__reason">{item.reason}</p>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="research-actions">
              <button type="button" className="button" disabled={venueBusy} onClick={() => void recommendVenues()}>
                {venueBusy ? "推荐中…" : "重新推荐"}
              </button>
              <button type="button" className="button button--primary" onClick={() => setVenueOpen(false)} disabled={venueBusy}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}
        >
          <div className="modal research-modal" role="dialog" aria-modal="true" aria-labelledby="research-create-title">
            <div className="modal__head">
              <h3 className="modal__title" id="research-create-title">新建研究项目</h3>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <p className="hint-text">先定论文类型；目标期刊可留空，创建后在「项目信息」里用 AI 推荐。工作台会建立六阶段、证据库、数据与写作目录。</p>
            <div className="research-form">
              <div className="research-field">
                <label htmlFor="research-project-title">项目名称</label>
                <input
                  id="research-project-title"
                  className="text-input"
                  placeholder="例如：医疗联邦学习中的个性化隐私预算分配"
                  value={form.title}
                  onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === "Enter") void handleCreate(); }}
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className="research-field__row">
                <div className="research-field">
                  <label htmlFor="research-project-kind">论文类型</label>
                  <select
                    id="research-project-kind"
                    className="research-select"
                    value={form.paperKind}
                    onChange={(event) => setForm((prev) => ({ ...prev, paperKind: event.target.value }))}
                  >
                    {KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                  </select>
                </div>
                <div className="research-field">
                  <label htmlFor="research-project-deadline">截止日期</label>
                  <input
                    id="research-project-deadline"
                    className="text-input"
                    type="date"
                    title="截止日期（可后补）"
                    value={form.deadline}
                    onChange={(event) => setForm((prev) => ({ ...prev, deadline: event.target.value }))}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="research-field">
                <label htmlFor="research-project-venue">目标期刊 / venue（可选）</label>
                <input
                  id="research-project-venue"
                  className="text-input"
                  placeholder="可留空，创建后由 AI 推荐"
                  value={form.targetVenue}
                  onChange={(event) => setForm((prev) => ({ ...prev, targetVenue: event.target.value }))}
                  autoComplete="off"
                />
                <span className="hint-text">留空即可：创建后在「项目信息 → 目标期刊」点「AI 推荐期刊」。</span>
              </div>
            </div>
            <div className="research-actions">
              <button type="button" className="button" onClick={() => setShowCreate(false)} disabled={busy}>取消</button>
              <button type="button" className="button button--primary" onClick={() => void handleCreate()} disabled={busy}>
                {busy ? "创建中…" : "创建项目"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
