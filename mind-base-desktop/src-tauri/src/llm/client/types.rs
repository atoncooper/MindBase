//! Chat message/tool-call/usage types and client construction for LLM calls.

use std::time::Duration;

use rusqlite::Connection;

use crate::llm::ai_providers::{self, ApiProtocol};
use crate::llm::api_keys;

use super::anthropic::{anthropic_chat_endpoint, build_anthropic_payload, parse_anthropic_content};
use super::openai::{
    build_non_stream_payload, build_stream_payload, openai_chat_endpoint, parse_chat_content,
};
use super::vision::{has_images, strip_images};

/// One message of an LLM conversation (`role`: system | user | assistant |
/// tool), with optional tool-calling fields for the agentic loop.
#[derive(Debug, Clone)]
pub(crate) struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Assistant-only: request-shape tool_calls array (assembled by the model).
    pub tool_calls: Option<serde_json::Value>,
    /// Tool-result-only: the id of the call this message answers.
    pub tool_call_id: Option<String>,
    /// Multimodal attachments (data URLs, e.g. `data:image/jpeg;base64,...`).
    /// Non-empty → the request body carries content as a parts array
    /// (text + image_url) instead of a plain string. Only set on
    /// tool-result / user messages by the vision pipeline.
    pub images: Vec<String>,
}

impl ChatMessage {
    pub(crate) fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            images: Vec::new(),
        }
    }

    /// Assistant message carrying requested tool calls (request shape).
    pub(crate) fn assistant_with_tool_calls(
        content: String,
        tool_calls: serde_json::Value,
    ) -> Self {
        Self {
            role: "assistant".to_string(),
            content,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
            images: Vec::new(),
        }
    }

    /// Tool execution result answering one call id.
    pub(crate) fn tool_result(tool_call_id: String, content: String) -> Self {
        Self {
            role: "tool".to_string(),
            content,
            tool_calls: None,
            tool_call_id: Some(tool_call_id),
            images: Vec::new(),
        }
    }

    /// Tool execution result that additionally carries vision attachments
    /// (image data URLs fetched from image/PDF knowledge-base documents).
    pub(crate) fn tool_result_with_images(
        tool_call_id: String,
        content: String,
        images: Vec<String>,
    ) -> Self {
        let mut message = Self::tool_result(tool_call_id, content);
        message.images = images;
        message
    }

    /// Request-body JSON for this message.
    pub(super) fn to_payload(&self) -> serde_json::Value {
        // Multimodal form: text part + image parts (OpenAI-compatible
        // content array; DashScope compatible-mode accepts the same shape
        // for its VL models).
        let content = if self.images.is_empty() {
            serde_json::Value::String(self.content.clone())
        } else {
            let mut parts = vec![serde_json::json!({
                "type": "text",
                "text": self.content,
            })];
            for url in &self.images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                }));
            }
            serde_json::Value::Array(parts)
        };
        let mut value = serde_json::json!({ "role": self.role, "content": content });
        if let Some(calls) = &self.tool_calls {
            value["tool_calls"] = calls.clone();
        }
        if let Some(id) = &self.tool_call_id {
            value["tool_call_id"] = serde_json::Value::String(id.clone());
        }
        value
    }
}

/// One assembled tool call from a streamed assistant turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolCallReq {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments string (assembled from argument fragments).
    pub arguments: String,
}

/// Token accounting for one completion.
///
/// Mirrors the OpenAI `usage` object (DashScope compatible mode answers with
/// the same shape). Counts default to 0 when a provider omits a field; the
/// camelCase wire form is what the frontend and the `chat_messages.usage`
/// JSON column store.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

impl TokenUsage {
    /// True when every counter is zero (i.e. no measurable usage).
    pub(crate) fn is_empty(&self) -> bool {
        self.input_tokens == 0 && self.output_tokens == 0 && self.total_tokens == 0
    }

    /// Accumulate another completion's counters into this one (saturating).
    pub(crate) fn merge(&mut self, other: TokenUsage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }
}

/// Build a chat client from stored credentials; `None` when no provider has
/// a key (callers surface a settings hint).
pub(crate) fn chat_client_from_conn(conn: &Connection) -> Result<Option<ChatClient>, String> {
    // 用户在「模型配置」里指定的默认提供方优先——前提是它真的配了密钥；
    // 否则按内置优先级链自动选择（DashScope 是一等公民，其余按目录顺序）。
    let preferred = crate::infra::config::load(conn)?.default_chat_provider;
    if let Some(provider) = preferred.as_deref() {
        if ai_providers::is_chat(provider) && chat_provider_configured(conn, provider)? {
            return Ok(Some(chat_client_for(conn, provider)?));
        }
    }
    for provider in ["dashscope", "deepseek", "openrouter"]
        .into_iter()
        .chain(ai_providers::chat_ids())
    {
        if chat_provider_configured(conn, provider)? {
            return Ok(Some(chat_client_for(conn, provider)?));
        }
    }
    Ok(None)
}

/// 某个对话提供方是否已配置密钥。
fn chat_provider_configured(conn: &Connection, provider: &str) -> Result<bool, String> {
    Ok(api_keys::read_raw_config(conn, provider)?.is_some())
}

/// 为「指定」的对话提供方构建客户端（对话界面的手动选择走这里）。
/// 未配置密钥时直接报错，让用户去对应卡片填写。
pub(crate) fn chat_client_for(conn: &Connection, provider: &str) -> Result<ChatClient, String> {
    let Some(def) = ai_providers::find(provider) else {
        return Err(format!("未知的对话提供方：{provider}"));
    };
    if !def.chat {
        return Err(format!("{} 不是对话类提供方", def.label));
    }
    let Some((api_key, custom_base)) = api_keys::read_raw_config(conn, def.id)? else {
        return Err(format!(
            "尚未配置 {} 的 API Key，请在「模型配置」中填写后再使用",
            def.label
        ));
    };
    let stored_model = api_keys::read_model(conn, def.id)?;
    let model = if stored_model.is_empty() {
        def.default_model.to_string()
    } else {
        stored_model
    };
    if model.is_empty() {
        return Err(format!(
            "请在「模型配置」中为 {} 配置模型后再使用问答",
            def.label
        ));
    }
    ChatClient::new(def, custom_base, api_key, model)
}

/// Blocking chat client routed through the configured egress proxy
/// (proxy-first with a direct fallback; direct-only when unset).
#[derive(Clone)]
pub(crate) struct ChatClient {
    pub(super) endpoint: String,
    pub(super) api_key: String,
    pub(super) model: String,
    pub(super) provider_id: String,
    pub(super) protocol: ApiProtocol,
}

impl ChatClient {
    fn new(
        def: &'static ai_providers::ProviderDef,
        custom_base: String,
        api_key: String,
        model: String,
    ) -> Result<Self, String> {
        let base = if custom_base.trim().is_empty() {
            def.default_base.to_string()
        } else {
            custom_base.trim().trim_end_matches('/').to_string()
        };
        if base.is_empty() {
            return Err(format!("请先为 {} 填写 Base URL", def.label));
        }
        let endpoint = match def.protocol {
            ApiProtocol::OpenAiCompletions => openai_chat_endpoint(&base),
            ApiProtocol::AnthropicMessages => anthropic_chat_endpoint(&base),
        };
        Ok(Self {
            endpoint,
            api_key,
            model,
            provider_id: def.id.to_string(),
            protocol: def.protocol,
        })
    }

    pub(crate) fn model_name(&self) -> &str {
        &self.model
    }

    /// The resolved chat endpoint URL — lets callers (orchestrator routing,
    /// quiz grading) build egress agents for the same route this client
    /// posts to.
    pub(crate) fn endpoint_url(&self) -> &str {
        &self.endpoint
    }

    /// Provider id for error messages (never the secret).
    pub(super) fn provider_label(&self) -> &str {
        &self.provider_id
    }

    /// Attach protocol-specific auth headers to one request.
    pub(super) fn authorize(&self, request: ureq::Request) -> ureq::Request {
        match self.protocol {
            ApiProtocol::OpenAiCompletions => {
                request.set("Authorization", &format!("Bearer {}", self.api_key))
            }
            ApiProtocol::AnthropicMessages => request
                .set("x-api-key", &self.api_key)
                .set("anthropic-version", "2023-06-01")
                // 兼容网关（MiniMax / Kimi Coding 等）读取 Bearer；官方忽略。
                .set("Authorization", &format!("Bearer {}", self.api_key)),
        }
    }

    /// Request body for both protocols (stream / non-stream, optional tools).
    pub(super) fn request_body(
        &self,
        messages: &[ChatMessage],
        tools: Option<&serde_json::Value>,
        stream: bool,
    ) -> serde_json::Value {
        match self.protocol {
            ApiProtocol::OpenAiCompletions => {
                let mut payload = if stream {
                    build_stream_payload(&self.model, messages)
                } else {
                    build_non_stream_payload(&self.model, messages)
                };
                if let Some(tools) = tools {
                    payload["tools"] = tools.clone();
                }
                payload
            }
            ApiProtocol::AnthropicMessages => {
                build_anthropic_payload(&self.model, messages, tools, stream)
            }
        }
    }

    /// One non-streaming completion through a caller-supplied agent.
    fn post_completion(
        &self,
        agent: &ureq::Agent,
        messages: &[ChatMessage],
    ) -> Result<String, String> {
        let payload = self.request_body(messages, None, false);
        let request = self
            .authorize(agent.post(&self.endpoint))
            .set("Content-Type", "application/json");
        let response = request.send_json(payload).map_err(|err| match err {
            ureq::Error::Status(code, response) => {
                let detail = response.into_string().unwrap_or_default();
                format!(
                    "对话模型调用失败（{}，HTTP {code}）：{}",
                    self.provider_label(),
                    truncate(&detail, 200)
                )
            }
            other => format!("对话模型请求失败：{other}"),
        })?;
        let body = response
            .into_string()
            .map_err(|err| format!("读取对话响应失败：{err}"))?;
        match self.protocol {
            ApiProtocol::OpenAiCompletions => parse_chat_content(&body),
            ApiProtocol::AnthropicMessages => parse_anthropic_content(&body),
        }
    }

    /// One completion through a caller-supplied agent — used for auxiliary
    /// short calls (title generation) that need their own tight timeout.
    pub(crate) fn complete_with(
        &self,
        agent: &ureq::Agent,
        messages: &[ChatMessage],
    ) -> Result<String, String> {
        self.post_completion(agent, messages)
    }

    /// Non-streaming completion through the configured egress route with the
    /// standard proxy-first-then-direct fallback and an explicit timeout —
    /// used by short auxiliary jobs (title naming) that must survive
    /// networks where the direct route is blocked.
    pub(crate) fn complete_turn(
        &self,
        timeout: Duration,
        messages: &[ChatMessage],
    ) -> Result<String, String> {
        let (primary, fallback) = api_keys::egress_agents(timeout, &self.endpoint)?;
        let attempt =
            |agent: &ureq::Agent, msgs: &[ChatMessage]| -> Result<String, String> {
                self.post_completion(agent, msgs)
            };
        match attempt(&primary, messages) {
            Ok(body) => Ok(body),
            Err(first_err) => {
                // 视觉回退：带图请求被不支持多模态的模型以 HTTP 4xx 拒绝时，
                // 去图在同路由重试一次，再走直连回退。
                if has_images(messages) {
                    let stripped = strip_images(messages);
                    if let Ok(body) = attempt(&primary, &stripped) {
                        return Ok(body);
                    }
                }
                match &fallback {
                    Some(agent) => {
                        if let Ok(body) = attempt(agent, messages) {
                            return Ok(body);
                        }
                        if has_images(messages) {
                            let stripped = strip_images(messages);
                            if let Ok(body) = attempt(agent, &stripped) {
                                return Ok(body);
                            }
                        }
                        Err(first_err)
                    }
                    None => Err(first_err),
                }
            }
        }
    }
}

/// Clip long error bodies for display.
pub(super) fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.trim().to_string()
    } else {
        let cut: String = text.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}
