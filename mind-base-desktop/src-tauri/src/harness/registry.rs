//! Tool registry — the desktop counterpart of app/tools/{base,registry}.py.
//!
//! Every capability an agent can invoke registers one [`LocalTool`]: a wire
//! spec (name / description / JSON-schema parameters) plus an `execute` that
//! receives the per-turn [`ToolContext`]. The OpenAI `tools` array sent to
//! the model is generated from registered specs — never hand-maintained.
//!
//! Mirrors the backend contract where a tool returns `{"content": str,
//! **extras}`: extras ride out of [`ToolOutput`] as provenance hits or
//! nested-agent steps.

use serde_json::Value;

use crate::ingest::KnowledgeHit;

/// Nested agent progress surfaced through `delegate_to_agent`.
#[derive(Debug, Clone)]
pub(crate) struct SubStep {
    pub action: String,
    pub query: String,
    pub preview: String,
}

/// Normalized tool result: model-facing text plus structured extras.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolOutput {
    pub content: String,
    pub hits: Vec<KnowledgeHit>,
    pub sub_steps: Vec<SubStep>,
}

impl ToolOutput {
    pub(crate) fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            ..Default::default()
        }
    }

    pub(crate) fn with_hits(content: String, hits: Vec<KnowledgeHit>) -> Self {
        Self {
            content,
            hits,
            ..Default::default()
        }
    }
}

/// Reentrant sub-agent runner installed by the top-level chat loop; the
/// delegate tool calls it instead of reaching into agent modules directly.
pub(crate) type DelegateFn =
    dyn Fn(&str, &str) -> Result<(String, Vec<SubStep>), String> + Send + Sync + 'static;

/// Per-turn resources every tool may touch. Carries `&Db` directly (not an
/// AppHandle) so unit tests can build contexts over in-memory databases.
/// Network-capable tools resolve their own locking windows (embed outside
/// the lock, store inside).
pub(crate) struct ToolContext<'a> {
    pub db: &'a crate::db::Db,
    /// Absent when no DashScope key is configured — embedding-backed tools
    /// self-report unavailability instead of failing the whole turn.
    pub embed_client: Option<&'a crate::embeddings::EmbedClient>,
    /// Present when a conversational provider is configured — needed by tools
    /// that themselves call an LLM (compressed-summary generation).
    pub chat_client: Option<&'a crate::llm_chat::ChatClient>,
    pub session_id: &'a str,
    /// Present only while the chat agent's ReAct loop is running.
    pub delegate: Option<&'a DelegateFn>,
}

/// Wire identity of one registered tool.
#[derive(Debug, Clone)]
pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub parameters: Value,
}

/// Behavior half of a tool. `Send + Sync` so scoped-thread execution works.
pub(crate) trait LocalTool: Send + Sync {
    fn spec(&self) -> &ToolSpec;
    fn execute(&self, ctx: &ToolContext<'_>, arguments: &str) -> Result<ToolOutput, String>;
}

/// Registry keyed by tool name; late registration overwrites with a warning
/// (mirrors backend registry.register).
#[derive(Default)]
pub(crate) struct ToolRegistry {
    tools: Vec<Box<dyn LocalTool>>,
}

impl ToolRegistry {
    pub(crate) fn register(&mut self, tool: Box<dyn LocalTool>) {
        let name = tool.spec().name;
        if self.tools.iter().any(|existing| existing.spec().name == name) {
            eprintln!("[REGISTRY] tool `{name}` registered twice; overwriting");
            self.tools.retain(|existing| existing.spec().name != name);
        }
        self.tools.push(tool);
    }

    pub(crate) fn get(&self, name: &str) -> Option<&dyn LocalTool> {
        self.tools
            .iter()
            .find(|tool| tool.spec().name == name)
            .map(|tool| tool.as_ref())
    }

    pub(crate) fn names(&self) -> Vec<&'static str> {
        self.tools.iter().map(|tool| tool.spec().name).collect()
    }
}

/// Parse the required string argument `name` out of raw tool arguments.
pub(crate) fn require_string_arg(arguments: &str, name: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(arguments)
        .map_err(|err| format!("工具参数解析失败：{err}"))?;
    let parsed = value
        .get(name)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or_default();
    if parsed.is_empty() {
        return Err(format!("工具参数缺少 {name}"));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct DummyTool {
        spec: ToolSpec,
    }
    impl LocalTool for DummyTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        fn execute(&self, _ctx: &ToolContext<'_>, _arguments: &str) -> Result<ToolOutput, String> {
            Ok(ToolOutput::text("ok"))
        }
    }

    fn dummy(name: &'static str) -> DummyTool {
        DummyTool {
            spec: ToolSpec {
                name,
                description: format!("{name} 描述"),
                parameters: json!({"type": "object", "properties": {}}),
            },
        }
    }

    #[test]
    fn registration_overwrites_and_lists() {
        let mut registry = ToolRegistry::default();
        registry.register(Box::new(dummy("alpha")));
        registry.register(Box::new(dummy("beta")));
        assert_eq!(registry.names(), vec!["alpha", "beta"]);

        // Same-name registration replaces rather than duplicates.
        registry.register(Box::new(dummy("alpha")));
        assert_eq!(registry.names(), vec!["beta", "alpha"]);
        assert!(registry.get("alpha").is_some());
        assert!(registry.get("missing").is_none());
    }

    #[test]
    fn require_string_arg_trims_and_rejects_empty() {
        assert_eq!(
            require_string_arg(r#"{"query": " 词 "}"#, "query").unwrap(),
            "词"
        );
        assert!(require_string_arg("{}", "query").is_err());
        assert!(require_string_arg("broken", "query").is_err());
    }
}
