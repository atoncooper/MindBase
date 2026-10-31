//! Reentrant sub-agent runs — depth-limited delegation.
//!
//! Contract:
//! - top-level chat may delegate to any specialist (memory / note / code /
//!   search / academic / research);
//! - academic / research may delegate **once more** to search / memory only
//!   (they often need docs lookup or history detail while writing), but those
//!   grandchildren can never delegate again — the cap is structural, not a
//!   prompt hint.

use super::harness;
use super::react::{react_loop, ReactCallbacks};
use super::{DelegateFn, SubStep, ToolContext};
use crate::agent::agents::AgentKind;
use crate::infra::db::Db;
use crate::llm::client::ChatClient;
use tauri::Manager;

/// Run a SUB-agent (memory / note / code / search / academic / research)
/// reentrantly. Children of chat get one optional nested delegation when they
/// are academic/research; everyone else has no delegate slot.
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
    run_sub_agent_inner(
        kind,
        handle,
        client,
        embed_client,
        session_id,
        query,
        on_child_step,
        true,
    )
}

/// Wrap a custom agent role into a self-contained task prompt.
fn custom_agent_question(name: &str, role_prompt: &str, query: &str) -> String {
    format!(
        "【自定义子代理 · {name}】\n\n角色与工作方式：\n{}\n\n任务：\n{}\n\n要求：以该角色完成上述任务，直接给出结论与必要步骤；不要复述角色设定。",
        role_prompt.trim(),
        query.trim()
    )
}

/// Run a user-created custom agent (role prompt) with the chat toolset.
/// Shares the parent session, so findings/history/files stay available.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_custom_agent(
    handle: &tauri::AppHandle,
    client: &ChatClient,
    embed_client: Option<&crate::llm::embeddings::EmbedClient>,
    session_id: &str,
    name: &str,
    role_prompt: &str,
    query: &str,
    on_child_step: &mut dyn FnMut(u32, &str, &str),
) -> Result<(String, Vec<SubStep>, Option<crate::llm::client::TokenUsage>), String> {
    let question = custom_agent_question(name, role_prompt, query);
    run_sub_agent_inner(
        AgentKind::Chat,
        handle,
        client,
        embed_client,
        session_id,
        &question,
        on_child_step,
        false,
    )
}

/// Targets a sub-agent may itself delegate to (one extra level, no recursion).
fn nested_targets(kind: AgentKind) -> Option<&'static [&'static str]> {
    match kind {
        AgentKind::Academic | AgentKind::Research => Some(&["search", "memory"]),
        _ => None,
    }
}

/// Build the nested delegate channel for academic/research children.
fn nested_delegate(
    kind: AgentKind,
    handle: &tauri::AppHandle,
    client: &ChatClient,
    embed_client: Option<&crate::llm::embeddings::EmbedClient>,
    session_id: &str,
) -> Option<std::sync::Arc<DelegateFn>> {
    nested_targets(kind)?;
    let handle = handle.clone();
    let client = client.clone();
    let embed = embed_client.cloned();
    let session = session_id.to_string();
    let closure: Box<DelegateFn> = Box::new(move |agent_name: &str, query: &str| {
        let child_kind = match agent_name {
            "search" => AgentKind::Search,
            "memory" => AgentKind::Memory,
            other => {
                return Err(format!(
                    "子代理只能委托 search / memory，不能委托 {other}"
                ))
            }
        };
        let mut noop = |_: u32, _: &str, _: &str| {};
        run_sub_agent_inner(
            child_kind,
            &handle,
            &client,
            embed.as_ref(),
            &session,
            query,
            &mut noop,
            false,
        )
        .map(|(answer, steps, _usage)| (answer, steps))
    });
    Some(std::sync::Arc::from(closure))
}

#[allow(clippy::too_many_arguments)]
fn run_sub_agent_inner(
    kind: AgentKind,
    handle: &tauri::AppHandle,
    client: &ChatClient,
    embed_client: Option<&crate::llm::embeddings::EmbedClient>,
    session_id: &str,
    query: &str,
    on_child_step: &mut dyn FnMut(u32, &str, &str),
    allow_nested_delegate: bool,
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
        delegate: if allow_nested_delegate {
            nested_delegate(kind, handle, client, embed_client, session_id)
        } else {
            None
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_agent_question_keeps_role_and_task() {
        let prompt = custom_agent_question("data-cleaner", "你是数据清洗工程师。", "清洗 csv 缺失值");
        assert!(prompt.contains("data-cleaner"));
        assert!(prompt.contains("数据清洗工程师"));
        assert!(prompt.contains("清洗 csv 缺失值"));
        assert!(prompt.contains("不要复述角色设定"));
    }

    #[test]
    fn only_academic_and_research_get_a_nested_delegate() {
        assert_eq!(
            nested_targets(AgentKind::Academic),
            Some(&["search", "memory"][..])
        );
        assert_eq!(
            nested_targets(AgentKind::Research),
            Some(&["search", "memory"][..])
        );
        assert!(nested_targets(AgentKind::Chat).is_none());
        assert!(nested_targets(AgentKind::Search).is_none());
        assert!(nested_targets(AgentKind::Memory).is_none());
        assert!(nested_targets(AgentKind::Note).is_none());
        assert!(nested_targets(AgentKind::Code).is_none());
    }
}
