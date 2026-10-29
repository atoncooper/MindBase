//! Per-agent system prompt assembly: base prompt loading + bound-tool schema.

use super::harness;
use super::registry::ToolContext;
use crate::agent::agents::AgentKind;

/// Schema restricted to one agent's bound tool subset.
pub(super) fn schema_for(kind: AgentKind) -> serde_json::Value {
    harness().runtime.schema_for_names(kind.tools())
}

/// Read the agent's mandatory base prompt from its data-dir tree
/// (`<data>/prompts/<agent>/base.md`, bundled fallback when missing).
pub(super) fn base_prompt(ctx: &ToolContext, kind: AgentKind) -> Result<String, String> {
    let dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(crate::agent::prompts::load_base(&dir, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_for_filters_to_agent_allowlist() {
        // Touching harness() requires Tauri state; the pure helper is covered
        // indirectly through registry::schema tests. Here we only assert the
        // allow-lists themselves stay disjoint from delegation for children.
        assert!(!AgentKind::Memory.tools().contains(&"delegate_to_agent"));
        assert!(AgentKind::Chat.tools().contains(&"delegate_to_agent"));
    }
}
