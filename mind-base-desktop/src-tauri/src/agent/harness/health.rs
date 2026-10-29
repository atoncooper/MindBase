//! Harness status cards: aggregated health facts + registered tool list.

use super::{harness, Harness};
use crate::agent::agents::AgentKind;

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
    const KINDS: [AgentKind; 7] = [
        AgentKind::Chat,
        AgentKind::Memory,
        AgentKind::Note,
        AgentKind::Code,
        AgentKind::Search,
        AgentKind::Academic,
        AgentKind::Research,
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
