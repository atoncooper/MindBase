/**
 * 科研工作台：桌面端内部子视图（Google Workspace 视觉体系）。
 *
 * 全屏两栏工作区：左侧研究项目栏（搜索 + 列表 + AI 绑定状态），右侧项目页
 * （项目头 + M3 主 tab + 卡片内容区）。样式全部收敛在 ./research/research.css
 * 的 .research-scope 作用域内（浅色 / 深色均按 Google 令牌取值），不改动
 * 应用其余域的视觉。数据与交互逻辑保持不变。
 */

import { useEffect, useMemo, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  PAPER_KIND_LABELS, RESEARCH_STAGES, STAGE_ADVICE, STAGE_LABELS,
  addResearchArtifact, createResearchProject, getResearchProject, listResearchEvents,
  listResearchProjects, updateResearchProject, updateResearchStage,
  type ProjectDetail, type ResearchEvent, type ResearchProject,
} from "../lib/research";
import DataTab from "./research/DataTab";
import LiteratureTab from "./research/LiteratureTab";
import WritingTab from "./research/WritingTab";
import { errorText, formatDate, formatDateTime } from "./research/common";
import { HOME_HASH, navigate } from "../lib/router";
import { CHAT_MODE_JUMP_KEY } from "../lib/chat";
import {
  getActiveResearchProjectId,
  setActiveResearchProject,
  setPendingResearchPrompt,
  setResearchNewChatFlag,
} from "../lib/research-context";
import { SearchGlyph } from "./icons";
import "./research/research.css";

type ResearchTab = "overview" | "literature" | "data" | "writing";
const TABS: Array<{ id: ResearchTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "literature", label: "文献" },
  { id: "data", label: "数据" },
  { id: "writing", label: "写作" },
];
const STATUS_LABEL: Record<string, string> = {
  locked: "未开始", active: "进行中", submitted: "待审核",
  approved: "已通过", frozen: "已冻结", rework: "需返工",
};
function stageClass(status: string): string {
  switch (status) {
    case "approved": case "frozen": return "is-done";
    case "active": return "is-active";
    case "submitted": return "is-submitted";
    case "rework": return "is-rework";
    default: return "";
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
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<ResearchTab>("overview");
  const [query, setQuery] = useState("");
  const [writingDirty, setWritingDirty] = useState(false);
  const [form, setForm] = useState({ title: "", paperKind: "journal", targetVenue: "", deadline: "" });
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactKind, setArtifactKind] = useState("doc");
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
  async function loadDetail(projectId: string): Promise<void> {
    const next = await getResearchProject(projectId);
    setDetail(next);
    setEvents(await listResearchEvents(projectId, 20));
  }
  useEffect(() => { void loadProjects(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo<ResearchProject[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === "") return projects;
    return projects.filter((row) => {
      const haystack = [row.title, row.targetVenue, row.field, STAGE_LABELS[row.currentStage] ?? ""].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [projects, query]);

  async function selectProject(projectId: string): Promise<void> {
    setSelectedId(projectId); setActiveResearchProject(projectId); setWritingDirty(false); setError(null);
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
  async function handleAddArtifact(): Promise<void> {
    if (detail === null) return;
    const title = artifactTitle.trim();
    if (title === "") { setError("请填写产物标题"); return; }
    setBusy(true); setError(null);
    try {
      const next = await addResearchArtifact(detail.project.id, { stage: detail.project.currentStage, kind: artifactKind, title });
      setDetail(next); setArtifactTitle("");
      setEvents(await listResearchEvents(detail.project.id, 20));
      await loadProjects(detail.project.id);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
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
        {/* 左：研究项目栏 */}
        <aside className="rs-rail" aria-label="研究项目">
          <label className="rs-search">
            <SearchGlyph />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目、期刊或阶段"
              aria-label="搜索研究项目"
            />
          </label>

          <div className="rs-rail__head">
            <span>研究项目</span>
            <span className="rs-rail__count">{projects.length}</span>
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

        {/* 右：项目页 */}
        <main className="rs-main">
          {error !== null && (
            <p className="error-text rs-banner" onClick={() => setError(null)} title="点击关闭">
              {error}
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

              <div className="rs-content">
                {tab === "overview" && (
                  <div className="rs-pane">
                    <section className="card">
                      <div className="research-section-head">
                        <h3>研究阶段</h3>
                        <span className="hint-text">点击任意阶段切换为进行中</span>
                      </div>
                      <div className="research-stages">
                        {stageRows.map((row, index) => (
                          <button
                            key={row.stage}
                            type="button"
                            disabled={busy}
                            className={"research-stage " + stageClass(row.status)}
                            onClick={() => void handleStage(row.stage)}
                            title={"设为进行中：" + (row.label ?? row.stage)}
                          >
                            <span className="research-stage__dot">
                              {row.status === "approved" || row.status === "frozen" ? "✓" : index + 1}
                            </span>
                            <span className="research-stage__label">{row.label ?? STAGE_LABELS[row.stage] ?? row.stage}</span>
                            <span className="research-stage__status">{STATUS_LABEL[row.status] ?? row.status}</span>
                          </button>
                        ))}
                      </div>
                    </section>

                    <div className="research-grid2">
                      <section className="card">
                        <div className="research-section-head">
                          <h3>当前阶段建议</h3>
                          <span className="rs-chip rs-chip--primary">{currentStageLabel}</span>
                          <span className="spacer" />
                          <button type="button" className="button research-btn-sm" onClick={() => openInChat("请结合当前科研项目的阶段、产物、文献与数据，给出这个阶段的下一步建议与主要风险。")}>
                            让 AI 拆解
                          </button>
                        </div>
                        <p className="hint-text" style={{ margin: 0 }}>{advice}</p>
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
                                placeholder="YYYY-MM-DD"
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
                            <div><dt>目标期刊</dt><dd>{project.targetVenue === "" ? "未填写" : project.targetVenue}</dd></div>
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
                          <span className="hint-text">只追加，不改写</span>
                        </div>
                        {events.length === 0 ? (
                          <div className="research-empty"><p>暂无动态。创建项目、导入文献、上传数据集后，这里会留下记录。</p></div>
                        ) : (
                          <ul className="rs-activity">
                            {events.map((row) => (
                              <li key={row.id}>
                                <span className="rs-activity__dot" aria-hidden="true" />
                                <span className="rs-activity__body">
                                  <span className="rs-activity__kind">{row.kind}</span>
                                  <span className="rs-activity__meta">{formatDateTime(row.ts)} · {row.actor}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    </div>
                  </div>
                )}

                {tab === "literature" && <LiteratureTab key={project.id} projectId={project.id} />}
                {tab === "data" && <DataTab key={project.id} projectId={project.id} />}
                {tab === "writing" && <WritingTab key={project.id} projectId={project.id} onDirtyChange={setWritingDirty} />}
              </div>
            </>
          )}
        </main>
      </div>

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
            <p className="hint-text">先定论文类型与目标期刊，工作台会建立六阶段、证据库、数据与写作目录。</p>
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
                    placeholder="YYYY-MM-DD（可后补）"
                    value={form.deadline}
                    onChange={(event) => setForm((prev) => ({ ...prev, deadline: event.target.value }))}
                  />
                </div>
              </div>
              <div className="research-field">
                <label htmlFor="research-project-venue">目标期刊 / venue</label>
                <input
                  id="research-project-venue"
                  className="text-input"
                  placeholder="例如：IEEE TNNLS / 中文核心（可后补）"
                  value={form.targetVenue}
                  onChange={(event) => setForm((prev) => ({ ...prev, targetVenue: event.target.value }))}
                />
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
