//! AgentHarness — desktop composition of the five-piece backend harness:
//! ToolRegistry (registry.rs) + AgentRuntime (runtime.rs) +
//! AgentOrchestrator (orchestrator.rs) + Lifecycle/CircuitBreaker
//! (lifecycle.rs) + Scheduler (scheduler.rs), wired around one generic ReAct
//! loop shared by every agent ([`crate::agent::agents::AgentKind`]).
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

mod health;
mod interaction;
mod plan;
mod prompt;
mod react;
mod subagent;

use std::sync::{Arc, OnceLock};

use crate::agent::agents::AgentKind;

pub(crate) use self::lifecycle::{spawn_cleanup_thread, LifecycleManager, BREAKER_OPEN_MESSAGE};
pub(crate) use self::registry::{DelegateFn, SubStep, ToolContext, ToolOutput};

// Commands re-exported together with the `#[tauri::command]` wrapper macros
// they generate, so `generate_handler!` keeps resolving them via this path.
pub use self::health::harness_health;
pub use self::health::harness_tools;
pub use self::health::{__cmd__harness_health, __cmd__harness_tools};
pub use self::health::{__tauri_command_name_harness_health, __tauri_command_name_harness_tools};
// Status aggregation and `ask_user` payload shapes are only built inside this
// package; kept re-exported so their historical item paths stay valid.
#[allow(unused_imports)]
pub(crate) use self::health::health;
pub use self::interaction::InteractionView;
#[allow(unused_imports)]
pub use self::interaction::{InteractionField, InteractionOption};
pub use self::plan::{PlanSnapshot, PlanStepView};
pub(crate) use self::react::{add_usage, react_loop, ReactCallbacks, ReactOutcome};
pub(crate) use self::subagent::{run_custom_agent, run_sub_agent};

/// Global singleton — agents/tools register once, every command shares it.
static HARNESS: OnceLock<Arc<Harness>> = OnceLock::new();

pub(crate) struct Harness {
    pub runtime: runtime::AgentRuntime,
    pub orchestrator: orchestrator::Orchestrator,
    pub lifecycle: Arc<LifecycleManager>,
    pub scheduler: scheduler::AgentScheduler,
}

impl Harness {
    /// Look up one registered tool by name (test support / introspection).
    pub(crate) fn tool(&self, name: &str) -> Option<std::sync::Arc<dyn registry::LocalTool>> {
        self.runtime.registry().get(name)
    }

    /// Names of every registered tool (test support / diagnostics).
    pub(crate) fn tool_names(&self) -> Vec<&'static str> {
        self.runtime.registry().names()
    }

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
        // ask_user — 结构化交互；同样在 react_loop 内本地拦截（卡片推给前端，
        // 本轮立即结束等用户回答）。
        runtime
            .registry_mut()
            .register(Box::new(tools::AskUserTool));
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
        // Public web search (Bing/Baidu + optional SearxNG) — see web_search.rs.
        runtime
            .registry_mut()
            .register(Box::new(crate::agent::web_search::WebSearchTool));
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
        // Local shell execution (pwsh / cmd / bash) — gated by
        // AppConfig.shell_enabled (default off) inside the tool itself.
        runtime
            .registry_mut()
            .register(Box::new(tools::RunCommandTool));
        // Structured git / GitHub CLI tools (same config gate + audit as run_command).
        runtime
            .registry_mut()
            .register(Box::new(tools::GitTool));
        runtime
            .registry_mut()
            .register(Box::new(tools::GhTool));
        // OS-level sandboxed execution (AppContainer / bubblewrap / seatbelt).
        runtime
            .registry_mut()
            .register(Box::new(tools::RunSandboxedTool));
        // Long-running automation tasks (AI-supervised): start/status/logs/kill/retry/due.
        for tool in [
            Box::new(tools::StartAutomationTool) as Box<dyn registry::LocalTool>,
            Box::new(tools::AutomationStatusTool),
            Box::new(tools::AutomationLogSearchTool),
            Box::new(tools::AutomationLogReadTool),
            Box::new(tools::AutomationKillTool),
            Box::new(tools::AutomationRetryTool),
            Box::new(tools::AutomationDueTool),
            Box::new(tools::AutomationListTool),
            Box::new(tools::UsageStatsTool),
            Box::new(tools::CreateAgentTool),
            Box::new(tools::ListAgentsTool),
            Box::new(tools::AcademicLiteratureTool),
            Box::new(tools::AcademicProjectTool),
            Box::new(tools::AcademicManuscriptTool),
            Box::new(tools::AcademicEvidenceTool),
        ] {
            runtime.registry_mut().register(tool);
        }

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
}
