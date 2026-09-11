//! Long-lived agent tasks (plan/1.0.10-AgentMemory §6): agents that run in
//! the background, own a budget, accept injected messages at ReAct step
//! boundaries (trap semantics), and deposit their outcome onto the session
//! blackboard. The main agent spawns/steers/stops them; they never talk to
//! each other directly.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::agents::AgentKind;
use crate::db::Db;

/// Hard caps a task runs under — the LLM decides *when* to stop, the runtime
/// enforces *that* it stops (belt and braces).
#[derive(Debug, Clone, Copy)]
pub(crate) struct TaskBudget {
    pub max_steps: usize,
    pub deadline_secs: u64,
    pub max_tool_calls: u32,
}

impl Default for TaskBudget {
    fn default() -> Self {
        Self {
            max_steps: 16,
            deadline_secs: 600,
            max_tool_calls: 40,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskStatus {
    Running,
    Done,
    Failed,
    Cancelled,
    BudgetExhausted,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
            TaskStatus::BudgetExhausted => "budget_exhausted",
        }
    }
}

struct TaskEntry {
    agent: AgentKind,
    description: String,
    /// Blackboard / transcript the outcome deposits into.
    session_id: String,
    status: TaskStatus,
    result: Option<String>,
    error: Option<String>,
    tool_calls: u32,
    steps_done: u32,
    cancel: Arc<AtomicBool>,
    mailbox: Arc<Mutex<Vec<String>>>,
    /// Latest plan snapshot (from the plan tool) for the status panel.
    plan: Arc<Mutex<Option<crate::harness::PlanSnapshot>>>,
    started_at: Instant,
    budget: TaskBudget,
}

static TASKS: OnceLock<Mutex<HashMap<String, TaskEntry>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, TaskEntry>> {
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// UI-facing snapshot of one task.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub task_id: String,
    pub agent: String,
    pub description: String,
    pub session_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub tool_calls: u32,
    pub steps_done: u32,
    /// Latest plan snapshot from the plan tool (None = no plan yet).
    pub plan: Option<crate::harness::PlanSnapshot>,
    /// Seconds since spawn (running tasks keep counting).
    pub elapsed_secs: u64,
    /// The budget the task runs under.
    pub max_steps: usize,
    pub deadline_secs: u64,
    pub max_tool_calls: u32,
}

fn finalize(
    task_id: &str,
    status: TaskStatus,
    result: Option<String>,
    error: Option<String>,
    steps_done: u32,
) {
    let mut registry = registry().lock().expect("task registry poisoned");
    if let Some(entry) = registry.get_mut(task_id) {
        entry.status = status;
        entry.result = result;
        entry.error = error;
        entry.steps_done = steps_done;
    }
}

/// Spawn one background agent task. Returns the task id immediately; the
/// outcome lands on the session blackboard and in `agent_task_get`.
pub(crate) fn spawn_task(
    app: tauri::AppHandle,
    agent: AgentKind,
    description: String,
    session_id: String,
    budget: TaskBudget,
) -> Result<String, String> {
    {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        crate::llm_chat::chat_client_from_conn(&conn)?
            .ok_or_else(|| "未配置任何对话模型，请先在「API 设置」中填写提供方密钥".to_string())?;
    }

    let task_id = format!("task-{}", &crate::db::local_id()[..8]);
    let entry = TaskEntry {
        agent,
        description: description.clone(),
        session_id: session_id.clone(),
        status: TaskStatus::Running,
        result: None,
        error: None,
        tool_calls: 0,
        steps_done: 0,
        cancel: Arc::new(AtomicBool::new(false)),
        mailbox: Arc::new(Mutex::new(Vec::new())),
        plan: Arc::new(Mutex::new(None)),
        started_at: Instant::now(),
        budget,
    };
    registry()
        .lock()
        .expect("task registry poisoned")
        .insert(task_id.clone(), entry);

    let runner_task_id = task_id.clone();
    let runner_session = session_id;
    let runner_handle = app;
    std::thread::spawn(move || {
        run_task(
            runner_task_id,
            runner_handle,
            runner_session,
            description,
            budget,
        );
    });
    Ok(task_id)
}

fn run_task(
    task_id: String,
    handle: tauri::AppHandle,
    session_id: String,
    description: String,
    budget: TaskBudget,
) {
    let (agent, cancel, mailbox, plan_slot, tool_counter) = {
        let registry = registry().lock().expect("task registry poisoned");
        let Some(entry) = registry.get(&task_id) else {
            return;
        };
        (
            entry.agent,
            entry.cancel.clone(),
            entry.mailbox.clone(),
            entry.plan.clone(),
            Arc::new(AtomicU32::new(0)),
        )
    };

    let outcome = (|| -> Result<crate::harness::ReactOutcome, String> {
        let db = handle.state::<Db>();
        let (chat_client, embed_client) = {
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            (
                crate::llm_chat::chat_client_from_conn(&conn)?
                    .ok_or_else(|| "未配置任何对话模型".to_string())?,
                crate::embeddings::embed_client_from_conn_opt(&conn)?,
            )
        };
        let ctx = crate::harness::ToolContext {
            db: db.inner(),
            embed_client: embed_client.as_ref(),
            chat_client: Some(&chat_client),
            session_id: &session_id,
            agent,
            delegate: None,
        };

        // Budget enforcement lives in the probes: a crossed budget flips the
        // cancel latch and the loop wraps up with a forced final answer.
        let started = Instant::now();
        let deadline = Duration::from_secs(budget.deadline_secs);
        let counter = tool_counter.clone();
        let should_stop = move || {
            cancel.load(Ordering::Relaxed)
                || counter.load(Ordering::Relaxed) > budget.max_tool_calls
                || started.elapsed() > deadline
        };
        let counter_for_step = tool_counter.clone();
        let mut on_step = |_step_no: u32, _action: &str, _query: &str| {
            counter_for_step.fetch_add(1, Ordering::Relaxed);
        };
        let plan_slot_for_cb = plan_slot.clone();
        let on_plan = move |snapshot: &crate::harness::PlanSnapshot| {
            *plan_slot_for_cb.lock().expect("plan slot poisoned") = Some(snapshot.clone());
        };
        let mut noop_delta = |_: &str| {};

        let drain_mailbox = move || {
            let mut guard = mailbox.lock().expect("task mailbox poisoned");
            std::mem::take(&mut *guard)
        };

        let mut callbacks = crate::harness::ReactCallbacks {
            on_step: &mut on_step,
            on_delta: &mut noop_delta,
            should_stop: Some(&should_stop),
            on_plan: Some(&on_plan),
            mailbox: Some(&drain_mailbox),
            step_budget: Some(budget.max_steps),
        };
        crate::harness::react_loop(
            &chat_client,
            &ctx,
            agent,
            &[],
            &description,
            1,
            None,
            &mut callbacks,
        )
    })();

    // Steps done for the record (the loop ran to completion or was cut).
    let steps_done = tool_counter.load(Ordering::Relaxed);
    match outcome {
        Ok(result) => {
            let answer = if result.answer.trim().is_empty() {
                "（任务被中断，无完整输出）".to_string()
            } else {
                result.answer
            };
            let status = if cancel_was_requested(&task_id) {
                TaskStatus::Cancelled
            } else if result.interrupted {
                TaskStatus::BudgetExhausted
            } else {
                TaskStatus::Done
            };
            {
                let db = handle.state::<Db>();
                let lock = db.conn.lock();
                if let Ok(conn) = lock {
                    if let Err(err) = crate::harness::tools::record_session_finding(
                        &conn,
                        &session_id,
                        agent.name(),
                        &description,
                        &answer,
                    ) {
                        eprintln!("[TASKS] blackboard deposit failed: {err}");
                    }
                }
            }
            {
                let db = handle.state::<Db>();
                let lock = db.data_dir.lock();
                if let Ok(dir) = lock {
                    let root = dir.join("conversations").join(&session_id);
                    let _ = crate::store::append_turn(
                        &root,
                        agent.name(),
                        "task",
                        &description,
                        &answer,
                        serde_json::json!({"task_id": task_id, "status": status.as_str()}),
                    );
                }
            }
            finalize(&task_id, status, Some(answer), None, steps_done);
        }
        Err(error) => {
            finalize(
                &task_id,
                TaskStatus::Failed,
                None,
                Some(error.clone()),
                steps_done,
            );
            let db = handle.state::<Db>();
            let lock = db.data_dir.lock();
            if let Ok(dir) = lock {
                let root = dir.join("conversations").join(&session_id);
                let _ = crate::store::append_error(
                    &root,
                    &session_id,
                    0,
                    agent.name(),
                    "runtime",
                    &error,
                    &error,
                );
            }
        }
    }
}

fn cancel_was_requested(task_id: &str) -> bool {
    registry()
        .lock()
        .expect("task registry poisoned")
        .get(task_id)
        .map(|entry| entry.cancel.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// Queue a steering/query message for a running task; processed at the next
/// ReAct step boundary.
pub(crate) fn inject_task_message(task_id: &str, message: &str) -> Result<(), String> {
    let registry = registry().lock().expect("task registry poisoned");
    let entry = registry
        .get(task_id)
        .ok_or_else(|| format!("任务不存在：{task_id}"))?;
    if entry.status != TaskStatus::Running {
        return Err(format!(
            "任务 {task_id} 已结束（{}），无法注入",
            entry.status.as_str()
        ));
    }
    entry
        .mailbox
        .lock()
        .expect("task mailbox poisoned")
        .push(message.trim().to_string());
    Ok(())
}

pub(crate) fn stop_task(task_id: &str) -> Result<(), String> {
    let registry = registry().lock().expect("task registry poisoned");
    let entry = registry
        .get(task_id)
        .ok_or_else(|| format!("任务不存在：{task_id}"))?;
    entry.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

fn view_map(entry: &TaskEntry, task_id: &str) -> TaskView {
    TaskView {
        task_id: task_id.to_string(),
        agent: entry.agent.name().to_string(),
        description: entry.description.clone(),
        session_id: entry.session_id.clone(),
        status: entry.status.as_str().to_string(),
        result: entry.result.clone(),
        error: entry.error.clone(),
        tool_calls: entry.tool_calls,
        steps_done: entry.steps_done,
        plan: entry.plan.lock().expect("plan slot poisoned").clone(),
        elapsed_secs: entry.started_at.elapsed().as_secs(),
        max_steps: entry.budget.max_steps,
        deadline_secs: entry.budget.deadline_secs,
        max_tool_calls: entry.budget.max_tool_calls,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn parse_agent(name: &str) -> Result<AgentKind, String> {
    match name.trim() {
        "chat" => Ok(AgentKind::Chat),
        "memory" => Ok(AgentKind::Memory),
        "note" => Ok(AgentKind::Note),
        "code" => Ok(AgentKind::Code),
        "search" => Ok(AgentKind::Search),
        other => Err(format!("未知 agent：{other}")),
    }
}

#[tauri::command]
pub fn agent_task_spawn(
    app: tauri::AppHandle,
    agent: String,
    task: String,
    session_id: String,
    max_steps: Option<u32>,
    deadline_secs: Option<u64>,
    max_tool_calls: Option<u32>,
) -> Result<String, String> {
    let kind = parse_agent(&agent)?;
    let default = TaskBudget::default();
    let budget = TaskBudget {
        max_steps: max_steps.map(|n| n as usize).unwrap_or(default.max_steps),
        deadline_secs: deadline_secs.unwrap_or(default.deadline_secs),
        max_tool_calls: max_tool_calls.unwrap_or(default.max_tool_calls),
    };
    spawn_task(
        app,
        kind,
        task.trim().to_string(),
        session_id.trim().to_string(),
        budget,
    )
}

#[tauri::command]
pub fn agent_task_inject(task_id: String, message: String) -> Result<(), String> {
    inject_task_message(&task_id, &message)
}

#[tauri::command]
pub fn agent_task_stop(task_id: String) -> Result<(), String> {
    stop_task(&task_id)
}

#[tauri::command]
pub fn agent_task_get(task_id: String) -> Result<Option<TaskView>, String> {
    let registry = registry().lock().expect("task registry poisoned");
    Ok(registry
        .get(&task_id)
        .map(|entry| view_map(entry, &task_id)))
}

#[tauri::command]
pub fn agent_task_list() -> Result<Vec<TaskView>, String> {
    let registry = registry().lock().expect("task registry poisoned");
    Ok(registry
        .iter()
        .map(|(task_id, entry)| view_map(entry, task_id))
        .collect())
}
