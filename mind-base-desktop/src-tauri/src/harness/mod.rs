//! AgentHarness — desktop composition of the five-piece backend harness:
//! ToolRegistry (registry.rs) + AgentRuntime (runtime.rs) +
//! AgentOrchestrator (orchestrator.rs) + Lifecycle/CircuitBreaker
//! (lifecycle.rs) + Scheduler (scheduler.rs), wired around one generic ReAct
//! loop shared by every agent ([`crate::agents::AgentKind`]).
//!
//! Entry point for conversations is [`dispatch_chat`]: route (single-target
//! fast path today) → lifecycle gate (breaker + per-session lock) → react
//! loop with the full registry subset bound, delegation bridged reentrantly.

pub(crate) mod lifecycle;
pub(crate) mod orchestrator;
pub(crate) mod registry;
pub(crate) mod runtime;
pub(crate) mod scheduler;
pub(crate) mod tasks;
pub(crate) mod tools;

use std::sync::{Arc, OnceLock};

use crate::agents::{self, AgentKind};
use crate::ingest::KnowledgeHit;
use crate::llm_chat::{ChatClient, ChatMessage, ToolCallReq};
use tauri::Manager;

use crate::db::Db;

pub(crate) use self::lifecycle::{spawn_cleanup_thread, LifecycleManager, BREAKER_OPEN_MESSAGE};
pub(crate) use self::registry::{DelegateFn, SubStep, ToolContext, ToolOutput};

/// One step of an agent task plan.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlanStepView {
    pub desc: String,
    pub status: String, // pending | in_progress | done | failed | skipped
    pub note: String,
}

/// Serialized snapshot of the current plan (frontend-facing shape).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlanSnapshot {
    pub version: u32,
    pub steps: Vec<PlanStepView>,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanStepStatus {
    Pending,
    InProgress,
    Done,
    Failed,
    Skipped,
}

impl PlanStepStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
    fn mark(&self) -> &'static str {
        match self {
            Self::Pending => "·",
            Self::InProgress => "▶",
            Self::Done => "✓",
            Self::Failed => "✗",
            Self::Skipped => "⊘",
        }
    }
}

#[derive(Debug, Clone)]
struct PlanStep {
    desc: String,
    status: PlanStepStatus,
    note: String,
}

/// Per-run plan state — created via the plan tool, mutated as the run
/// proceeds, logged as checkpoint events.
#[derive(Debug, Clone, Default)]
struct PlanState {
    version: u32,
    steps: Vec<PlanStep>,
    replans: u32,
}

impl PlanState {
    fn snapshot(&self) -> PlanSnapshot {
        let done = self
            .steps
            .iter()
            .filter(|step| matches!(step.status, PlanStepStatus::Done | PlanStepStatus::Skipped))
            .count();
        PlanSnapshot {
            version: self.version,
            total: self.steps.len(),
            done,
            steps: self
                .steps
                .iter()
                .map(|step| PlanStepView {
                    desc: step.desc.clone(),
                    status: step.status.as_str().to_string(),
                    note: step.note.clone(),
                })
                .collect(),
        }
    }

    fn render(&self) -> String {
        let done = self
            .steps
            .iter()
            .filter(|step| matches!(step.status, PlanStepStatus::Done | PlanStepStatus::Skipped))
            .count();
        let mut lines = vec![format!("【任务计划 v{} · {}/{} 完成】", self.version, done, self.steps.len())];
        for (index, step) in self.steps.iter().enumerate() {
            let mark = step.status.mark();
            let line = format!("{} {}. {}", mark, index + 1, step.desc);
            lines.push(if step.note.is_empty() {
                line
            } else {
                format!("{line} —— {}", step.note)
            });
        }
        lines.join("
")
    }
}

const PLAN_REVISE_LIMIT: u32 = 3;

/// Per-turn progress hooks handed to [`react_loop`].
pub(crate) struct ReactCallbacks<'a> {
    pub on_step: &'a mut dyn FnMut(u32, &str, &str),
    pub on_delta: &'a mut dyn FnMut(&str),
    /// Cancellation probe polled between ReAct steps and per SSE frame;
    /// `None` = runs to completion (sub-agents, non-interactive runs).
    pub should_stop: Option<&'a dyn Fn() -> bool>,
    /// Mailbox drain polled at every step boundary — injected messages
    /// (steering / queries) become new conversation turns. Long-lived
    /// agent tasks only; `None` for plain runs.
    pub mailbox: Option<&'a dyn Fn() -> Vec<String>>,
    /// Plan-change callback fired whenever the agent mutates its task plan
    /// (create / update / revise) — drives the frontend plan panel.
    pub on_plan: Option<&'a dyn Fn(&PlanSnapshot)>,
    /// Step-budget override: task budgets may exceed the per-kind default.
    pub step_budget: Option<usize>,
}

impl ReactCallbacks<'_> {
    fn stopped(&self) -> bool {
        self.should_stop.is_some_and(|check| check())
    }
}

/// Everything one finished ReAct run produced.
#[derive(Debug, Default)]
pub(crate) struct ReactOutcome {
    pub answer: String,
    pub hits: Vec<KnowledgeHit>,
    /// Flattened nested-agent steps (from delegate executions).
    pub sub_steps: Vec<SubStep>,
    /// True when the run ended early via the caller's cancellation probe —
    /// `answer` may hold partial text (possibly empty).
    pub interrupted: bool,
}

/// Global singleton — agents/tools register once, every command shares it.
static HARNESS: OnceLock<Arc<Harness>> = OnceLock::new();

pub(crate) struct Harness {
    pub runtime: runtime::AgentRuntime,
    pub orchestrator: orchestrator::Orchestrator,
    pub lifecycle: Arc<LifecycleManager>,
    pub scheduler: scheduler::AgentScheduler,
}

impl Harness {
    fn new() -> Self {
        let mut runtime = runtime::AgentRuntime::new();
        runtime
            .registry_mut()
            .register(Box::new(tools::VectorSearchTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ListDocumentsTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::SearchChatHistoryTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GetRecentContextTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GetFullHistoryTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GetCompressedSummaryTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::SaveNoteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ListNotesTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GetNoteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::UpdateNoteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::DelegateToAgentTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::LoadSkillTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::LoadPromptTool));
        // L2 blackboard reader — every delegation auto-deposits findings.
        runtime
            .registry_mut()
            .register(Box::new(tools::GetSessionFindingsTool));
        // Task planning — plan 调用在 react_loop 内本地拦截处理（运行时状态机）。
        runtime.registry_mut().register(Box::new(tools::PlanTool));
        // Store readers (summary-first progressive disclosure) + per-agent
        // private memory writers.
        runtime
            .registry_mut()
            .register(Box::new(tools::ListHistoryTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ReadTurnTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ListErrorsTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ReadErrorTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::SearchContentTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::MemoryWriteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::MemorySearchTool));
        // Optional-network enhancement tools (search agent).
        runtime
            .registry_mut()
            .register(Box::new(tools::SearchDocsTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::WebCrawlTool));
        // Conversation-integrated artifact generation (chat agent).
        runtime
            .registry_mut()
            .register(Box::new(tools::GenerateResumeTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GenerateSlidesTool));
        // General file-system access (the agent's hands, not just exports).
        runtime
            .registry_mut()
            .register(Box::new(tools::ReadFileTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::WriteFileTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::ListDirTool));

        let mut orchestrator = orchestrator::Orchestrator::new();
        // Only chat is routable today — identical to the production backend;
        // sub-agents are reached through delegate_to_agent instead.
        orchestrator.register("chat", &AgentKind::Chat.description());

        let lifecycle = Arc::new(LifecycleManager::new());
        spawn_cleanup_thread(&lifecycle);

        Self {
            runtime,
            orchestrator,
            lifecycle,
            scheduler: scheduler::AgentScheduler::new(scheduler::SchedulerConfig::default()),
        }
    }
}

/// Shared harness instance; initializes lazily on first touch.
pub(crate) fn harness() -> &'static Arc<Harness> {
    HARNESS.get_or_init(|| Arc::new(Harness::new()))
}

/// Schema restricted to one agent's bound tool subset.
fn schema_for(kind: AgentKind) -> serde_json::Value {
    harness().runtime.schema_for_names(kind.tools())
}

/// Aggregated harness facts (runtime metrics, routable agents, session
/// count, queue slots) for the settings status card / future admin view.
pub(crate) fn health(harness: &Harness) -> serde_json::Value {
    serde_json::json!({
        "runtime": harness.runtime.monitor(),
        "routableAgents": harness
            .orchestrator
            .list_agents()
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>(),
        "activeSessions": harness.lifecycle.active_sessions(),
        "breakers": harness
            .lifecycle
            .breaker_snapshot()
            .into_iter()
            .map(|(name, state, failures)| {
                serde_json::json!({ "agent": name, "state": format!("{state:?}"), "failures": failures })
            })
            .collect::<Vec<_>>(),
        "schedulerSlots": harness.scheduler.slot_count(),
    })
}

/// Aggregated harness facts for the settings status card.
#[tauri::command]
pub fn harness_health() -> serde_json::Value {
    health(harness())
}

/// Every registered tool with the agents that bind it — powers the
/// 「工具清单」 card in the agent status pane.
#[tauri::command]
pub fn harness_tools() -> serde_json::Value {
    const KINDS: [AgentKind; 5] = [
        AgentKind::Chat,
        AgentKind::Memory,
        AgentKind::Note,
        AgentKind::Code,
        AgentKind::Search,
    ];
    let entries: Vec<serde_json::Value> = harness()
        .runtime
        .tool_specs()
        .into_iter()
        .map(|spec| {
            let agents: Vec<&str> = KINDS
                .iter()
                .filter(|kind| kind.tools().contains(&spec.name))
                .map(|kind| kind.name())
                .collect();
            serde_json::json!({
                "name": spec.name,
                "description": spec.description,
                "agents": agents,
            })
        })
        .collect();
    serde_json::json!({ "tools": entries })
}

/// Primary query argument of a tool call (first non-empty of the backend's
/// key list) — drives step-event labels.
fn primary_query(arguments: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(arguments) else {
        return String::new();
    };
    for key in ["query", "question", "q", "text"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

/// Handle one `plan` tool call against the run's plan state machine.
/// Every mutation is logged as a checkpoint event (events.jsonl) and pushed
/// to the frontend via the on_plan callback.
fn apply_plan(
    plan: &mut Option<PlanState>,
    arguments: &str,
    ctx: &ToolContext<'_>,
    kind: AgentKind,
    step_no: u32,
) -> ToolOutput {
    let value: serde_json::Value = match serde_json::from_str(arguments) {
        Ok(value) => value,
        Err(err) => return ToolOutput::text(format!("plan 参数解析失败：{err}")),
    };
    let action = value.get("action").and_then(|a| a.as_str()).unwrap_or("");

    fn parse_steps(value: &serde_json::Value) -> Vec<PlanStep> {
        value
            .get("steps")
            .and_then(|steps| steps.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let desc = item
                            .as_str()
                            .map(str::trim)
                            .map(str::to_string)
                            .or_else(|| {
                                item.get("desc")
                                    .and_then(|d| d.as_str())
                                    .map(|s| s.trim().to_string())
                            })?;
                        if desc.is_empty() {
                            return None;
                        }
                        Some(PlanStep {
                            desc,
                            status: PlanStepStatus::Pending,
                            note: String::new(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn log_checkpoint(ctx: &ToolContext<'_>, kind: AgentKind, step_no: u32, what: &str, status: &str) {
        if let Ok(dir) = ctx.db.data_dir.lock() {
            let root = dir.join("conversations").join(ctx.session_id);
            let _ = crate::store::append_event(
                &root,
                serde_json::json!({
                    "ev": "checkpoint",
                    "agent": kind.name(),
                    "step": step_no,
                    "what": what,
                    "status": status,
                }),
            );
        }
    }

    match action {
        "create" => {
            if plan.is_some() {
                return ToolOutput::text(
                    "计划已存在。调整剩余步骤用 action=revise；更新步骤状态用 action=update。",
                );
            }
            let steps = parse_steps(&value);
            if steps.is_empty() {
                return ToolOutput::text("steps 不能为空（每项为一步的描述）");
            }
            *plan = Some(PlanState { version: 1, steps, replans: 0 });
            log_checkpoint(ctx, kind, step_no, "created", "计划创建");
            ToolOutput::text(current_render(plan))
        }
        "update" => {
            let Some(state) = plan.as_mut() else {
                return ToolOutput::text("尚未创建计划（先用 action=create）");
            };
            let no = value.get("step").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
            if no == 0 || no > state.steps.len() {
                return ToolOutput::text(format!("步骤编号无效：{no}（1-{}）", state.steps.len()));
            }
            let status = value.get("status").and_then(|s| s.as_str()).unwrap_or("done");
            let parsed = match status {
                "pending" => PlanStepStatus::Pending,
                "in_progress" => PlanStepStatus::InProgress,
                "done" => PlanStepStatus::Done,
                "failed" => PlanStepStatus::Failed,
                "skipped" => PlanStepStatus::Skipped,
                other => return ToolOutput::text(format!("未知状态 {other}（pending|in_progress|done|failed|skipped）")),
            };
            let note = value
                .get("note")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let step = &mut state.steps[no - 1];
            step.status = parsed;
            step.note = note;
            log_checkpoint(ctx, kind, step_no, &format!("step {no}"), status);
            ToolOutput::text(current_render(plan))
        }
        "revise" => {
            let Some(state) = plan.as_mut() else {
                return ToolOutput::text("尚未创建计划");
            };
            if state.replans >= PLAN_REVISE_LIMIT {
                return ToolOutput::text(
                    "计划修订次数已达上限（3 次）。请基于当前计划继续执行，或直接总结已完成的产出。",
                );
            }
            let steps = parse_steps(&value);
            if steps.is_empty() {
                return ToolOutput::text("steps 不能为空");
            }
            state.replans += 1;
            state.version += 1;
            state.steps = steps;
            let reason = value
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            log_checkpoint(
                ctx,
                kind,
                step_no,
                &format!("revised v{}", state.version),
                &reason,
            );
            ToolOutput::text(current_render(plan))
        }
        other => ToolOutput::text(format!(
            "未知 action：{other}（可用：create 创建计划 / update 更新步骤状态 / revise 修订计划）"
        )),
    }
}

fn current_render(plan: &Option<PlanState>) -> String {
    plan.as_ref().map(PlanState::render).unwrap_or_default()
}

/// Read the agent's mandatory base prompt from its data-dir tree
/// (`<data>/prompts/<agent>/base.md`, bundled fallback when missing).
fn base_prompt(ctx: &ToolContext<'_>, kind: AgentKind) -> Result<String, String> {
    let dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(crate::prompts::load_base(&dir, kind))
}

/// Run the ReAct loop for one agent kind.
///
/// `delegate_depth` is 0 for top-level runs; child runs pass >0 together with
/// a ToolContext whose delegate slot is empty, which structurally enforces the
/// backend's two-level delegation cap.
#[allow(clippy::too_many_arguments)]
pub(crate) fn react_loop(
    client: &ChatClient,
    ctx: &ToolContext<'_>,
    kind: AgentKind,
    history: &[ChatMessage],
    question: &str,
    _delegate_depth: u32,
    memory_window: Option<&[agents::SearchWindowEntry]>,
    cb: &mut ReactCallbacks<'_>,
) -> Result<ReactOutcome, String> {
    let system_prompt = match kind {
        AgentKind::Chat => {
            // Skills digest + loadable-prompt index are scanned per turn: a
            // folder dropped into <data_dir>/skills (or an edited prompt md
            // under <data_dir>/prompts) is usable on the very next message.
            let (skills_text, prompts_index, base_md, message_count) = {
                let conn = ctx
                    .db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                let dir = ctx
                    .db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
                let message_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM chat_messages
                         WHERE chat_session_id = ?1 AND status = 'completed'",
                        rusqlite::params![ctx.session_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                (
                    crate::skills::enabled_skills_digest(&conn, &dir),
                    crate::prompts::prompts_index(&dir, kind),
                    crate::prompts::load_base(&dir, kind),
                    message_count,
                )
            };
            let mut prompt =
                agents::chat_system_prompt(&base_md, &skills_text, &prompts_index, kind.tools());
            if message_count > 0 {
                // Session meta: the model sees only the last few messages of
                // history — tell it there is more, and where to look.
                prompt.push_str(&format!(
                    "\n\n## 会话元信息\n本会话累计存档 {message_count} 条消息，而上方 history 只包含最近几条；\
                     更早的内容请用 get_compressed_summary / search_chat_history / list_history 主动查询，\
                     不要凭空假设「之前没聊过」。"
                ));
            }
            prompt
        }
        AgentKind::Memory => {
            let window_text = match memory_window {
                Some(entries) => agents::format_search_window(entries),
                None => agents::format_search_window(&[]),
            };
            agents::memory_system_prompt(&base_prompt(ctx, kind)?, &window_text, "chat", question)
        }
        AgentKind::Note => agents::note_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Code => agents::code_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Search => agents::search_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Academic => agents::academic_system_prompt(&base_prompt(ctx, kind)?, question),
    };

    let mut convo: Vec<ChatMessage> = Vec::with_capacity(history.len() + 2);
    convo.push(ChatMessage::new("system", system_prompt));
    convo.extend(history.iter().cloned());
    convo.push(ChatMessage::new("user", question));

    let mut all_hits: Vec<KnowledgeHit> = Vec::new();
    let mut all_sub_steps: Vec<SubStep> = Vec::new();

    // Per-run plan state (plan tool) — complex tasks decompose into steps,
    // each completed step is a checkpoint event; failed steps trigger
    // replanning (bounded revisions).
    let mut plan: Option<PlanState> = None;
    let mut plan_reminder_done = false;

    // Repetition detector (plan/1.0.10-AgentMemory §6.3): the same tool with
    // byte-identical arguments three times in one run triggers a steering
    // nudge instead of burning the remaining budget.
    let mut tool_call_counts: std::collections::HashMap<(String, String), u32> =
        std::collections::HashMap::new();
    const REPEAT_LIMIT: u32 = 3;

    let max_steps = cb.step_budget.unwrap_or_else(|| kind.max_steps());
    for step_no in 1..=max_steps {
        // Between-steps cancellation point (a stop pressed while tools were
        // executing lands here).
        if cb.stopped() {
            return Ok(ReactOutcome {
                answer: String::new(),
                hits: all_hits,
                sub_steps: all_sub_steps,
                interrupted: true,
            });
        }
        // Step-boundary mailbox drain (trap semantics — injected messages
        // are never applied mid-tool, only between steps).
        if let Some(drain) = cb.mailbox {
            for message in drain() {
                if message.trim().is_empty() {
                    continue;
                }
                convo.push(ChatMessage::new(
                    "user",
                    format!("【注入消息（来自主 agent / 系统，优先级高于原任务）】{message}"),
                ));
            }
        }
        let turn = client.stream_turn(
            &convo,
            Some(schema_for(kind)),
            &mut |delta| {
                (cb.on_delta)(delta);
            },
            cb.should_stop,
        )?;

        // Text-only response = the final answer.
        if !turn.wants_tools() {
            return Ok(ReactOutcome {
                answer: turn.content,
                hits: all_hits,
                sub_steps: all_sub_steps,
                interrupted: turn.interrupted,
            });
        }

        convo.push(ChatMessage::assistant_with_tool_calls(
            turn.content.clone(),
            assistant_tool_calls_payload(&turn.tool_calls),
        ));

        // 计划提醒：复杂任务跑了 3 步还没建计划 → 注入一次提醒（软性引导）。
        if !plan_reminder_done
            && step_no >= 3
            && plan.is_none()
            && !turn.tool_calls.is_empty()
            && matches!(
                kind,
                AgentKind::Chat | AgentKind::Code | AgentKind::Academic | AgentKind::Note
            )
        {
            plan_reminder_done = true;
            convo.push(ChatMessage::new(
                "user",
                "【系统提示】本任务已执行多步仍未建立计划。建议先用 plan 工具创建任务计划                 （把目标拆解为可检查的步骤），每步完成即更新状态；简单任务可忽略此提醒。",
            ));
        }

        // plan 工具本地拦截：计划是 react_loop 的运行时状态机，不经 registry
        // 并发执行；其余工具照常批量执行。
        let mut plan_results: Vec<(ToolCallReq, ToolOutput)> = Vec::new();
        let mut exec_calls: Vec<ToolCallReq> = Vec::new();
        for call in &turn.tool_calls {
            if call.name == "plan" {
                let output = apply_plan(&mut plan, &call.arguments, ctx, kind, step_no as u32);
                if let Some(snapshot) = plan.as_ref().map(PlanState::snapshot) {
                    if let Some(on_plan) = cb.on_plan {
                        on_plan(&snapshot);
                    }
                }
                let query = primary_query(&call.arguments);
                (cb.on_step)(step_no as u32, "plan", &query);
                plan_results.push((call.clone(), output));
            } else {
                exec_calls.push(call.clone());
            }
        }
        for executed in harness().runtime.execute(ctx, &exec_calls) {
            let call = &executed.call;
            let mut outcome = match executed.outcome {
                Ok(outcome) => outcome,
                // Runtime already isolates errors; this arm exists for
                // future non-isolated failures.
                Err(error) => registry::ToolOutput::text(format!("工具执行失败: {error}")),
            };

            let query = primary_query(&call.arguments);
            (cb.on_step)(step_no as u32, call.name.as_str(), &query);

            // Traceability streams (plan/1.0.10-AgentMemory §4): every tool
            // call lands in events.jsonl; failures additionally into
            // errors.jsonl with a resolvable detail span. Best-effort —
            // store failures never fail the turn.
            let tool_failed = outcome.content.starts_with("工具执行失败");
            if let Ok(dir) = ctx.db.data_dir.lock() {
                let root = dir.join("conversations").join(ctx.session_id);
                let _ = crate::store::append_event(
                    &root,
                    serde_json::json!({
                        "ev": "step",
                        "agent": kind.name(),
                        "step": step_no,
                        "tool": call.name,
                        "args_preview": query,
                        "ok": !tool_failed,
                    }),
                );
                if tool_failed {
                    let _ = crate::store::append_error(
                        &root,
                        ctx.session_id,
                        step_no as u32,
                        kind.name(),
                        "tool",
                        &outcome.content,
                        &outcome.content,
                    );
                }
            }

            // Memory keeps a rolling retrieval window of its own searches —
            // persisted per session (survives restarts). Best-effort.
            if kind == AgentKind::Memory {
                let entry =
                    agents::make_window_entry(&query, &outcome.content, vec![call.name.clone()]);
                let conn = ctx
                    .db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                if let Err(err) = crate::db::append_memory_window(&conn, ctx.session_id, entry) {
                    eprintln!("[MEMORY-WINDOW] append failed: {err}");
                }
            }

            // Repetition gate: the identical tool with byte-identical
            // arguments three times in one run triggers a steering nudge
            // instead of burning the remaining budget.
            let key = (call.name.clone(), call.arguments.clone());
            let count = tool_call_counts
                .entry(key)
                .and_modify(|count| *count += 1)
                .or_insert(1);
            if *count == REPEAT_LIMIT {
                convo.push(ChatMessage::new(
                    "user",
                    "【系统提示】检测到同一工具与相同参数被重复调用多次。请停止重复：更换检索角度、改用其他工具，或直接基于已有信息总结回答。",
                ));
            }

            // 视觉附件：工具命中图片文档时带原图（数据 URL），随工具结果
            // 进入多模态消息（仅视觉模型 + 开关开启时非空）。
            let tool_images = std::mem::take(&mut outcome.images);
            all_hits.extend(outcome.hits.iter().cloned());
            all_sub_steps.extend(outcome.sub_steps.iter().cloned());
            convo.push(ChatMessage::tool_result_with_images(
                call.id.clone(),
                outcome.content,
                tool_images,
            ));

            // Nested-agent steps surface as their own step frames so the UI
            // shows them under the same generating bubble.
            for sub in &outcome.sub_steps {
                let detail = if sub.preview.is_empty() {
                    sub.query.clone()
                } else {
                    format!("{} — {}", sub.query, sub.preview)
                };
                (cb.on_step)(
                    step_no as u32,
                    &format!("{}·{}", call.name, sub.action),
                    &detail,
                );
            }
        }

        // plan 工具结果以 tool 消息入列（渲染文本 = 当前计划清单）。
        for (call, output) in plan_results {
            convo.push(ChatMessage::tool_result(call.id.clone(), output.content));
        }
    }

    // Budget exhausted: force a tool-free closing answer.
    if cb.stopped() {
        return Ok(ReactOutcome {
            answer: String::new(),
            hits: all_hits,
            sub_steps: all_sub_steps,
            interrupted: true,
        });
    }
    let turn = client.stream_turn(
        &convo,
        None,
        &mut |delta| {
            (cb.on_delta)(delta);
        },
        cb.should_stop,
    )?;
    Ok(ReactOutcome {
        answer: turn.content,
        hits: all_hits,
        sub_steps: all_sub_steps,
        interrupted: turn.interrupted,
    })
}

/// Build the assistant request-shape tool_calls array for the conversation.
fn assistant_tool_calls_payload(turn_tool_calls: &[ToolCallReq]) -> serde_json::Value {
    serde_json::Value::Array(
        turn_tool_calls
            .iter()
            .map(|call| {
                serde_json::json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments }
                })
            })
            .collect(),
    )
}

/// Run a SUB-agent (memory / note) reentrantly — no session lock, no
/// delegation slot in its context (structural two-level cap).
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_sub_agent(
    kind: AgentKind,
    handle: &tauri::AppHandle,
    client: &ChatClient,
    embed_client: Option<&crate::embeddings::EmbedClient>,
    session_id: &str,
    query: &str,
    on_child_step: &mut dyn FnMut(u32, &str, &str),
) -> Result<(String, Vec<SubStep>), String> {
    let db = handle.state::<Db>();
    let ctx = ToolContext {
        db: db.inner(),
        embed_client,
        chat_client: Some(client),
        session_id,
        agent: kind,
        delegate: None, // children never delegate further (depth cap by design)
    };

    // The memory agent resumes its persisted retrieval window (SQLite —
    // survives restarts, shared across delegations of the same session).
    let memory_window = if kind == AgentKind::Memory {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        Some(crate::db::load_memory_window(&conn, session_id)?)
    } else {
        None
    };

    let mut noop_delta = |_: &str| {};
    let mut callbacks = ReactCallbacks {
        on_step: on_child_step,
        on_delta: &mut noop_delta,
        should_stop: None,
        on_plan: None,
        mailbox: None,
        step_budget: None,
    };

    let outcome = react_loop(
        client,
        &ctx,
        kind,
        &[], // sub-agents start fresh; the caller's question is self-contained
        query,
        1, // delegate_depth of the child
        memory_window.as_deref(),
        &mut callbacks,
    );
    match &outcome {
        Ok(_) => harness().lifecycle.record_success(kind.name(), session_id),
        Err(_) => harness().lifecycle.record_failure(kind.name(), session_id),
    }

    outcome.map(|result| (result.answer, result.sub_steps))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_query_prefers_backend_key_order() {
        assert_eq!(primary_query(r#"{"query":"a","question":"b"}"#), "a");
        assert_eq!(primary_query(r#"{"question":"b","q":"c"}"#), "b");
        assert_eq!(primary_query(r#"{"text":"d"}"#), "d");
        assert_eq!(primary_query("{}"), "");
    }

    #[test]
    fn assistant_payload_matches_request_shape() {
        let payload = assistant_tool_calls_payload(&[ToolCallReq {
            id: "i".into(),
            name: "vector_search".into(),
            arguments: "{}".into(),
        }]);
        assert_eq!(payload[0]["type"], "function");
        assert_eq!(payload[0]["function"]["name"], "vector_search");
    }

    #[test]
    fn schema_for_filters_to_agent_allowlist() {
        // Touching harness() requires Tauri state; the pure helper is covered
        // indirectly through registry::schema tests. Here we only assert the
        // allow-lists themselves stay disjoint from delegation for children.
        assert!(!AgentKind::Memory.tools().contains(&"delegate_to_agent"));
        assert!(AgentKind::Chat.tools().contains(&"delegate_to_agent"));
    }
}
