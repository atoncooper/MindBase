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
pub(crate) mod tools;

use std::sync::{Arc, OnceLock};

use crate::agents::{self, AgentKind};
use crate::ingest::KnowledgeHit;
use crate::llm_chat::{ChatClient, ChatMessage, ToolCallReq};
use tauri::Manager;

use crate::db::Db;

pub(crate) use self::lifecycle::{
    spawn_cleanup_thread, LifecycleManager, BREAKER_OPEN_MESSAGE,
};
pub(crate) use self::registry::{DelegateFn, SubStep, ToolContext};

/// Per-turn progress hooks handed to [`react_loop`].
pub(crate) struct ReactCallbacks<'a> {
    pub on_step: &'a mut dyn FnMut(u32, &str, &str),
    pub on_delta: &'a mut dyn FnMut(&str),
    /// Cancellation probe polled between ReAct steps and per SSE frame;
    /// `None` = runs to completion (sub-agents, non-interactive runs).
    pub should_stop: Option<&'a dyn Fn() -> bool>,
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
        runtime.registry_mut().register(Box::new(tools::VectorSearchTool));
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
        runtime.registry_mut().register(Box::new(tools::SaveNoteTool));
        runtime.registry_mut().register(Box::new(tools::ListNotesTool));
        runtime.registry_mut().register(Box::new(tools::GetNoteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::UpdateNoteTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::DelegateToAgentTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::LoadSkillTool));
        // Optional-network enhancement tools (search agent).
        runtime.registry_mut().register(Box::new(tools::SearchDocsTool));
        runtime.registry_mut().register(Box::new(tools::WebCrawlTool));
        // Conversation-integrated artifact generation (chat agent).
        runtime
            .registry_mut()
            .register(Box::new(tools::GenerateResumeTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GenerateSlidesTool));

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
            // Skills digest is scanned per turn: a folder dropped into
            // <data_dir>/skills is usable on the very next message.
            let skills_text = {
                let conn = ctx.db.conn.lock().map_err(|err| format!("failed to acquire database lock: {err}"))?;
                let dir = ctx
                    .db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
                crate::skills::enabled_skills_digest(&conn, &dir)
            };
            agents::chat_system_prompt(&skills_text, kind.tools())
        }
        AgentKind::Memory => {
            let window_text = match memory_window {
                Some(entries) => agents::format_search_window(entries),
                None => agents::format_search_window(&[]),
            };
            agents::memory_system_prompt(&window_text, "chat", question)
        }
        AgentKind::Note => agents::note_system_prompt(question),
        AgentKind::Code => agents::code_system_prompt(question),
        AgentKind::Search => agents::search_system_prompt(question),
    };

    let mut convo: Vec<ChatMessage> = Vec::with_capacity(history.len() + 2);
    convo.push(ChatMessage::new("system", system_prompt));
    convo.extend(history.iter().cloned());
    convo.push(ChatMessage::new("user", question));

    let mut all_hits: Vec<KnowledgeHit> = Vec::new();
    let mut all_sub_steps: Vec<SubStep> = Vec::new();

    let max_steps = kind.max_steps();
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
        let turn = client.stream_turn(&convo, Some(schema_for(kind)), &mut |delta| {
            (cb.on_delta)(delta);
        }, cb.should_stop)?;

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

        for executed in harness().runtime.execute(ctx, &turn.tool_calls) {
            let call = &executed.call;
            let outcome = match executed.outcome {
                Ok(outcome) => outcome,
                // Runtime already isolates errors; this arm exists for
                // future non-isolated failures.
                Err(error) => registry::ToolOutput::text(format!("工具执行失败: {error}")),
            };

            let query = primary_query(&call.arguments);
            (cb.on_step)(step_no as u32, call.name.as_str(), &query);

            // Memory keeps a rolling retrieval window of its own searches.
            if kind == AgentKind::Memory {
                let entry = agents::make_window_entry(
                    &query,
                    &outcome.content,
                    vec![call.name.clone()],
                );
                harness()
                    .lifecycle
                    .append_memory_window(ctx.session_id, entry);
            }

            all_hits.extend(outcome.hits.iter().cloned());
            all_sub_steps.extend(outcome.sub_steps.iter().cloned());
            convo.push(ChatMessage::tool_result(call.id.clone(), outcome.content));

            // Nested-agent steps surface as their own step frames so the UI
            // shows them under the same generating bubble.
            for sub in &outcome.sub_steps {
                let detail = if sub.preview.is_empty() {
                    sub.query.clone()
                } else {
                    format!("{} — {}", sub.query, sub.preview)
                };
                (cb.on_step)(step_no as u32, &format!("{}·{}", call.name, sub.action), &detail);
            }
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
    let turn = client.stream_turn(&convo, None, &mut |delta| {
        (cb.on_delta)(delta);
    }, cb.should_stop)?;
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
        delegate: None, // children never delegate further (depth cap by design)
    };

    let memory_window = (kind == AgentKind::Memory)
        .then(|| harness().lifecycle.memory_window(session_id));

    let mut noop_delta = |_: &str| {};
    let mut callbacks = ReactCallbacks {
        on_step: on_child_step,
        on_delta: &mut noop_delta,
        should_stop: None,
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
