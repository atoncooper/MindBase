//! AgentOrchestrator — LLM-based routing to the right agent.
//!
//! Desktop counterpart of app/harness/orchestrator.py, constants preserved:
//! 3 s routing timeout, verbatim routing prompt, `\b(name)\b`-style parsing,
//! and unconditional fallback to the default agent on any miss/timeout/error.

use std::time::Duration;

use crate::llm_chat::{ChatClient, ChatMessage};

/// Routing decision deadline (backend constant).
pub(crate) const ROUTING_TIMEOUT: Duration = Duration::from_secs(3);
pub(crate) const DEFAULT_AGENT: &str = "chat";

/// Minimal completion surface the router needs — lets tests substitute
/// scripted replies instead of constructing real provider clients.
pub(crate) trait CompletionClient {
    fn complete_with_agent(
        &self,
        agent: &ureq::Agent,
        messages: &[crate::llm_chat::ChatMessage],
    ) -> Result<String, String>;
}

impl CompletionClient for ChatClient {
    fn complete_with_agent(
        &self,
        agent: &ureq::Agent,
        messages: &[crate::llm_chat::ChatMessage],
    ) -> Result<String, String> {
        ChatClient::complete_with(self, agent, messages)
    }
}

const ROUTING_SYSTEM_TEMPLATE: &str = "你是一个查询路由专家。根据用户问题和可用 Agent 描述，选择最合适的 Agent。\n\n可用 Agent:\n{agent_list}\n\n只输出 Agent 名称（{agent_names}），不要解释，不要加标点。";

#[derive(Debug, Clone)]
pub(crate) struct AgentDescriptorEntry {
    pub name: String,
    pub description: String,
}

/// Registry of routable agents + the routing decision itself.
#[derive(Default)]
pub(crate) struct Orchestrator {
    agents: Vec<AgentDescriptorEntry>,
    default_agent: String,
}

impl Orchestrator {
    pub(crate) fn new() -> Self {
        Self {
            agents: Vec::new(),
            default_agent: DEFAULT_AGENT.to_string(),
        }
    }

    pub(crate) fn register(&mut self, name: &str, description: &str) {
        if self.agents.iter().any(|entry| entry.name == name) {
            self.agents.retain(|entry| entry.name != name);
        }
        self.agents.push(AgentDescriptorEntry {
            name: name.to_string(),
            description: description.to_string(),
        });
    }

    pub(crate) fn list_agents(&self) -> &[AgentDescriptorEntry] {
        &self.agents
    }

    /// Build the system prompt exactly like the backend (cached there; cheap
    /// enough here to rebuild per call).
    fn build_prompt(&self) -> String {
        let agent_list = self
            .agents
            .iter()
            .map(|entry| format!("- {}: {}", entry.name, entry.description))
            .collect::<Vec<_>>()
            .join("\n");
        let agent_names = self
            .agents
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>()
            .join("/");
        ROUTING_SYSTEM_TEMPLATE
            .replace("{agent_list}", &agent_list)
            .replace("{agent_names}", &agent_names)
    }

    /// Word-bounded containment check standing in for `\b(name)\b` — names
    /// are ASCII so byte-level boundary checks are safe.
    fn contains_word(haystack_lower: &str, name: &str) -> bool {
        let mut search_from = 0usize;
        while let Some(found) = haystack_lower[search_from..].find(name) {
            let start = search_from + found;
            let end = start + name.len();
            let before_ok = start == 0
                || !haystack_lower.as_bytes()[start - 1].is_ascii_alphanumeric();
            let after_ok = end >= haystack_lower.len()
                || !haystack_lower.as_bytes()[end].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
            search_from = start + name.len().max(1);
        }
        false
    }

    /// Pick the first registered agent whose name appears in the reply;
    /// anything else falls back to the default (mirrors backend parse-miss).
    fn parse_reply(&self, reply: &str) -> String {
        let lowered = reply.trim().to_lowercase();
        for entry in &self.agents {
            if Self::contains_word(&lowered, &entry.name.to_lowercase()) {
                return entry.name.clone();
            }
        }
        self.default_agent.clone()
    }

    /// Route one query. Zero registered agents → default immediately; a
    /// single agent short-circuits without any LLM call (both faithful).
    /// Every failure mode lands on the default agent.
    pub(crate) fn route<C: CompletionClient>(&self, client: &C, query: &str) -> String {
        if self.agents.is_empty() {
            return self.default_agent.clone();
        }
        if self.agents.len() == 1 {
            return self.agents[0].name.clone();
        }

        // A dedicated 3s-budget agent keeps routing from inheriting the
        // streaming client's long timeouts.
        let Ok(agent) = crate::api_keys::direct_agent(ROUTING_TIMEOUT) else {
            return self.default_agent.clone();
        };
        let messages = [
            ChatMessage::new("system", self.build_prompt()),
            ChatMessage::new("user", query),
        ];
        let parsed = client.complete_with_agent(&agent, &messages);
        match parsed {
            Ok(reply) => self.parse_reply(&reply),
            Err(_) => self.default_agent.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_agents() -> Orchestrator {
        let mut orchestrator = Orchestrator::new();
        orchestrator.register(
            "memory",
            "记忆检索助手。检索历史对话、压缩摘要与上下文。",
        );
        orchestrator.register(
            "chat",
            "收藏夹知识库助手。使用ReAct模式回答用户关于B站视频内容的问题。",
        );
        orchestrator
    }

    struct ScriptedClient {
        reply: &'static str,
    }
    impl CompletionClient for ScriptedClient {
        fn complete_with_agent(
            &self,
            _agent: &ureq::Agent,
            _messages: &[crate::llm_chat::ChatMessage],
        ) -> Result<String, String> {
            Ok(self.reply.to_string())
        }
    }

    #[test]
    fn single_registered_agent_short_circuits_without_llm() {
        let mut orchestrator = Orchestrator::new();
        orchestrator.register("chat", "唯一的选择");
        // Single-agent fast path never consults the client; a panicking stub
        // proves it (route must return before touching it).
        let client = NeverClient;
        assert_eq!(orchestrator.route(&client, "任何问题"), "chat");
    }

    struct NeverClient;
    impl CompletionClient for NeverClient {
        fn complete_with_agent(
            &self,
            _agent: &ureq::Agent,
            _messages: &[crate::llm_chat::ChatMessage],
        ) -> Result<String, String> {
            panic!("single-agent routing must not call the LLM");
        }
    }

    #[test]
    fn parse_reply_matches_words_and_falls_back() {
        let orchestrator = two_agents();
        assert_eq!(orchestrator.parse_reply("memory"), "memory");
        assert_eq!(orchestrator.parse_reply("我觉得 memory 更合适"), "memory");
        // Substring without word boundary ("memo") must not match…
        assert_eq!(
            orchestrator.parse_reply("memoized answers live elsewhere"),
            "chat"
        );
        // …and garbage falls back to chat.
        assert_eq!(orchestrator.parse_reply("完全无关的回答"), "chat");
    }

    #[test]
    fn llm_routing_parses_scripted_replies_and_times_out_to_default() {
        // Scripted reply naming memory routes there…
        let orchestrator = two_agents();
        let client = ScriptedClient { reply: "memory" };
        assert_eq!(orchestrator.route(&client, "我们之前聊过什么？"), "memory");

        // …while an unrelated reply falls back to chat.
        let fallback_client = ScriptedClient { reply: "完全无关的回答" };
        assert_eq!(orchestrator.route(&fallback_client, "问题"), "chat");

        // An erroring client also lands on the default.
        struct ErroringClient;
        impl CompletionClient for ErroringClient {
            fn complete_with_agent(
                &self,
                _: &ureq::Agent,
                _: &[crate::llm_chat::ChatMessage],
            ) -> Result<String, String> {
                Err("网络中断".into())
            }
        }
        assert_eq!(orchestrator.route(&ErroringClient, "问题"), "chat");
    }

    #[test]
    fn prompt_template_lists_every_agent() {
        let orchestrator = two_agents();
        let prompt = orchestrator.build_prompt();
        assert!(prompt.contains("- memory: 记忆检索助手"));
        assert!(prompt.contains("- chat: 收藏夹知识库助手"));
        assert!(prompt.contains("memory/chat"));
        assert!(!prompt.contains("{agent_list}"));
    }

    #[test]
    fn empty_registry_routes_to_default_instantly() {
        let orchestrator = Orchestrator::new();
        let client = NeverClient;
        assert_eq!(orchestrator.route(&client, "q"), "chat");
    }
}
