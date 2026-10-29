//! Reentrant sub-agent runs — two-level delegation cap by construction.

use super::harness;
use super::react::{react_loop, ReactCallbacks};
use super::{SubStep, ToolContext};
use crate::agent::agents::AgentKind;
use crate::infra::db::Db;
use crate::llm::client::ChatClient;
use tauri::Manager;

/// Run a SUB-agent (memory / note) reentrantly — no session lock, no
/// delegation slot in its context (structural two-level cap).
///
/// Returns the child answer, its flattened steps and the token usage its
/// own ReAct run accumulated, so the parent turn can fold it into the
/// per-message total.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_sub_agent(
    kind: AgentKind,
    handle: &tauri::AppHandle,
    client: &ChatClient,
    embed_client: Option<&crate::llm::embeddings::EmbedClient>,
    session_id: &str,
    query: &str,
    on_child_step: &mut dyn FnMut(u32, &str, &str),
) -> Result<(String, Vec<SubStep>, Option<crate::llm::client::TokenUsage>), String> {
    let db = handle.state::<Db>();
    // Owned context (clonable): the runtime dispatches every tool call onto its
    // own thread with a hard timeout, so tools can no longer borrow this turn.
    let ctx = ToolContext {
        db: db.inner().clone(),
        embed_client: embed_client.cloned().map(std::sync::Arc::new),
        chat_client: Some(std::sync::Arc::new(client.clone())),
        session_id: session_id.to_string(),
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
        Some(crate::infra::db::load_memory_window(&conn, session_id)?)
    } else {
        None
    };

    let mut noop_delta = |_: &str| {};
    let mut callbacks = ReactCallbacks {
        on_step: on_child_step,
        on_delta: &mut noop_delta,
        should_stop: None,
        on_plan: None,
        on_interact: None,
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

    outcome.map(|result| (result.answer, result.sub_steps, result.usage))
}
