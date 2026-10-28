//! Conversational LLM client for workspace Q&A.
//!
//! Provider choice mirrors the backend's split: DashScope first (its key is
//! required for embeddings anyway), OpenRouter as the alternative when
//! DashScope is not configured. The per-provider `model` stored in API
//! settings is honored; unset falls back to a cheap default (`qwen-flash`)
//! on DashScope, while OpenRouter demands an explicit model.

use std::io::BufRead;
use std::time::Duration;

use rusqlite::Connection;

use crate::ai_providers::{self, ApiProtocol};
use crate::api_keys;

/// Overall cap for one streamed completion (ureq's total timeout includes
/// reading the body, so this bounds the whole generation).
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);

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
    fn to_payload(&self) -> serde_json::Value {
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

/// Conservative name-based vision capability heuristic. Models whose name
/// matches any of these fragments are treated as able to consume image
/// parts; everything else stays text-only.
pub(crate) fn model_supports_vision(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    [
        "qwen-vl",
        "qwen2-vl",
        "qwen2.5-vl",
        "qvq",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-turbo",
        "chatgpt-4o",
        "o3",
        "o4",
        "claude-3",
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
        "gemini",
        "glm-4v",
        "glm-4.5v",
        "pixtral",
        "llava",
        "internvl",
        "doubao-1.5-vision",
        "doubao-seed",
    ]
    .iter()
    .any(|marker| model.contains(marker))
}

/// Does any message in the sequence carry image attachments?
fn has_images(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| !message.images.is_empty())
}

/// Clone the sequence with every image attachment removed — the fallback
/// shape used when a provider rejects multimodal content.
fn strip_images(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .map(|message| {
            let mut stripped = message.clone();
            stripped.images = Vec::new();
            stripped
        })
        .collect()
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

/// Parse one provider `usage` object (OpenAI / DashScope compatible shape:
/// `prompt_tokens` / `completion_tokens` / `total_tokens`). Tolerates the
/// `input_tokens` / `output_tokens` aliases and derives a missing total from
/// the two halves; `None` when the payload carries no usable usage object.
pub(crate) fn parse_provider_usage(value: Option<&serde_json::Value>) -> Option<TokenUsage> {
    let object = value?.as_object()?;
    if object.is_empty() {
        return None;
    }
    let pick = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|key| object.get(*key).and_then(serde_json::Value::as_u64))
    };
    let input_tokens = pick(["prompt_tokens", "input_tokens"]).unwrap_or_default();
    let output_tokens = pick(["completion_tokens", "output_tokens"]).unwrap_or_default();
    let total_tokens = object
        .get("total_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
    Some(TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

/// Outcome of one streamed assistant turn. Accumulates text deltas, finish
/// reason and tool-call fragments (the wire format splits each call's
/// id/name/arguments across many chunks, keyed by index).
#[derive(Debug, Default)]
pub(crate) struct StreamTurn {
    pub content: String,
    pub finish_reason: String,
    pub tool_calls: Vec<ToolCallReq>,
    /// Token usage reported by the provider for this turn (`None` when the
    /// provider ignored `stream_options.include_usage` or the frame was cut
    /// short). Some providers only send it on the final, choices-empty frame.
    pub usage: Option<TokenUsage>,
    /// Raw fragment accumulator: (index, id, name, arguments).
    fragments: Vec<(i64, String, String, String)>,
    /// True when the caller's cancellation flag ended the stream early —
    /// `content` holds whatever was generated before the cut.
    pub interrupted: bool,
}

impl StreamTurn {
    /// Fold one SSE chunk JSON into the accumulator. Pure w.r.t. the outside
    /// world so fixtures can pin provider quirks.
    pub(crate) fn apply_chunk(&mut self, chunk: &serde_json::Value) {
        // Usage is a top-level field, independent of `choices`: several
        // providers (OpenAI, DashScope compatible mode) attach it to the
        // final frame, whose `choices` array is empty. Only frames that
        // actually carry a usage object update the accumulator.
        if let Some(usage) = parse_provider_usage(chunk.get("usage")) {
            self.usage = Some(usage);
        }
        if let Some(reason) = chunk
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str())
        {
            if !reason.is_empty() {
                self.finish_reason = reason.to_string();
            }
        }
        if let Some(content) = chunk
            .pointer("/choices/0/delta/content")
            .and_then(|c| c.as_str())
        {
            self.content.push_str(content);
        }
        if let Some(fragments) = chunk
            .pointer("/choices/0/delta/tool_calls")
            .and_then(|v| v.as_array())
        {
            for fragment in fragments {
                let index = fragment
                    .get("index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default();
                let id = fragment
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let name = fragment
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let arguments = fragment
                    .pointer("/function/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match self
                    .fragments
                    .iter_mut()
                    .find(|(existing, ..)| *existing == index)
                {
                    Some((_, existing_id, existing_name, existing_args)) => {
                        if !id.is_empty() {
                            *existing_id = id.to_string();
                        }
                        if !name.is_empty() {
                            *existing_name = name.to_string();
                        }
                        existing_args.push_str(arguments);
                    }
                    None => self.fragments.push((
                        index,
                        id.to_string(),
                        name.to_string(),
                        arguments.to_string(),
                    )),
                }
            }
        }
    }

    /// Materialize assembled tool calls; empty when none arrived.
    pub(crate) fn take_tool_calls(&mut self) -> Vec<ToolCallReq> {
        let mut calls: Vec<ToolCallReq> = self
            .fragments
            .drain(..)
            .filter(|(_, id, name, _)| !id.is_empty() && !name.is_empty())
            .map(|(_, id, name, arguments)| ToolCallReq {
                id,
                name,
                arguments,
            })
            .collect();
        calls.sort_by_key(|call| call.id.clone());
        calls
    }

    /// True when the model asked for tools instead of answering.
    pub(crate) fn wants_tools(&self) -> bool {
        !self.tool_calls.is_empty()
    }
}

/// Whether to ask the provider for a usage frame in streaming responses
/// (`stream_options.include_usage`, OpenAI-compatible). On by default;
/// `MIND_BASE_STREAM_USAGE=off` restores the bare request body for the rare
/// provider that rejects the field with a 400.
pub(crate) fn stream_usage_enabled() -> bool {
    match std::env::var("MIND_BASE_STREAM_USAGE") {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "off" | "false" | "0" | "no"
        ),
        Err(_) => true,
    }
}

/// Build the streaming chat-completions request body. Pure for tests (the
/// usage toggle reads the environment, which defaults to on).
pub(crate) fn build_stream_payload(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(ChatMessage::to_payload).collect::<Vec<_>>(),
        "temperature": 0.3,
        "stream": true
    });
    if stream_usage_enabled() {
        payload["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    payload
}

/// The same body for a non-streaming call: streaming-only knobs are stripped
/// (providers that reject `stream_options` do so regardless of `stream`).
fn build_non_stream_payload(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut payload = build_stream_payload(model, messages);
    payload["stream"] = serde_json::Value::Bool(false);
    if let Some(object) = payload.as_object_mut() {
        object.remove("stream_options");
    }
    payload
}

/// Join a Base URL with the OpenAI-compatible chat path.
fn openai_chat_endpoint(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

/// Join a Base URL with the Anthropic messages path.
///
/// Anthropic 官方 Base（api.anthropic.com）与 MiniMax / Kimi Coding 等兼容
/// 网关的 Base 都不含 /v1；已经带 /v1 的自定义 Base 只补 /messages。
fn anthropic_chat_endpoint(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

/// Build a chat client from stored credentials; `None` when no provider has
/// a key (callers surface a settings hint).
pub(crate) fn chat_client_from_conn(conn: &Connection) -> Result<Option<ChatClient>, String> {
    // 用户在「模型配置」里指定的默认提供方优先——前提是它真的配了密钥；
    // 否则按内置优先级链自动选择（DashScope 是一等公民，其余按目录顺序）。
    let preferred = crate::config::load(conn)?.default_chat_provider;
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
    endpoint: String,
    api_key: String,
    model: String,
    provider_id: String,
    protocol: ApiProtocol,
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
    fn provider_label(&self) -> &str {
        &self.provider_id
    }

    /// Attach protocol-specific auth headers to one request.
    fn authorize(&self, request: ureq::Request) -> ureq::Request {
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
    fn request_body(
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

    /// Streamed completion over an arbitrary message sequence.
    ///
    /// Every text delta is forwarded through on_delta as it arrives; the
    /// concatenated full answer is returned once the stream ends. Proxy retry
    /// only happens when nothing was received yet (retryable == true) — a
    /// mid-stream failure would otherwise duplicate already-emitted content,
    /// and an authoritative empty reply must not be re-asked.
    pub(crate) fn stream_turn(
        &self,
        messages: &[ChatMessage],
        tools: Option<serde_json::Value>,
        on_delta: &mut dyn FnMut(&str),
        should_stop: Option<&dyn Fn() -> bool>,
    ) -> Result<StreamTurn, String> {
        // Fresh long-timeout agents: the shared HTTP_TIMEOUT would cut off
        // generations longer than two minutes mid-stream.
        let (primary, fallback) = api_keys::egress_agents(STREAM_TIMEOUT, &self.endpoint)?;

        // Err payload: (message, retryable-with-proxy). Declared mut: the
        // closure forwards through &mut on_delta, so re-invoking it for the
        // proxy retry needs a mutable binding.
        let mut run = |agent: &ureq::Agent,
                       msgs: &[ChatMessage]|
         -> Result<StreamTurn, (String, bool)> {
            let payload = self.request_body(msgs, tools.as_ref(), true);
            let request = self
                .authorize(agent.post(&self.endpoint))
                .timeout(STREAM_TIMEOUT)
                .set("Content-Type", "application/json");
            let response = request.send_json(payload).map_err(|err| {
                let message = match err {
                    ureq::Error::Status(code, response) => {
                        let detail = response.into_string().unwrap_or_default();
                        format!(
                            "对话模型调用失败（{}，HTTP {code}）：{}",
                            self.provider_label(),
                            truncate(&detail, 200)
                        )
                    }
                    other => format!("对话模型请求失败：{other}"),
                };
                (message, true)
            })?;
            let status = response.status();
            if status != 200 {
                let detail = response.into_string().unwrap_or_default();
                return Err((
                    format!(
                        "对话模型调用失败（HTTP {status}）：{}",
                        truncate(&detail, 200)
                    ),
                    true,
                ));
            }

            let reader = response.into_reader();
            let buffered = std::io::BufReader::new(reader);
            let mut turn = StreamTurn::default();
            let mut emitted = false;
            let mut anthropic = AnthropicStreamState::default();
            for line in buffered.lines() {
                // Cancellation is checked per SSE frame: the frame in flight
                // still applies, then the stream is cut and the partial turn
                // is returned as-is.
                if should_stop.is_some_and(|check| check()) {
                    turn.interrupted = true;
                    break;
                }
                let line = line.map_err(|err| (format!("读取流式响应中断：{err}"), emitted))?;
                let Some(payload) = line.strip_prefix("data:") else {
                    continue; // blank separators / comments / non-data frames
                };
                if payload.trim() == "[DONE]" {
                    break;
                }
                let Ok(event) = serde_json::from_str::<serde_json::Value>(payload) else {
                    continue; // provider keep-alives / unparsable frames
                };
                let chunks = match self.protocol {
                    ApiProtocol::OpenAiCompletions => vec![event],
                    ApiProtocol::AnthropicMessages => {
                        if event.get("type").and_then(|v| v.as_str()) == Some("error") {
                            let detail = event
                                .pointer("/error/message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("上游返回错误");
                            return Err((
                                format!(
                                    "对话模型调用失败（{}）：{}",
                                    self.provider_label(),
                                    truncate(detail, 200)
                                ),
                                emitted,
                            ));
                        }
                        anthropic_events_to_chunks(&event, &mut anthropic)
                    }
                };
                for chunk in chunks {
                    let before = turn.content.len();
                    turn.apply_chunk(&chunk);
                    if turn.content.len() > before {
                        emitted = true;
                        on_delta(&turn.content[before..]);
                    }
                }
            }
            turn.tool_calls = turn.take_tool_calls();
            if !turn.interrupted && turn.content.is_empty() && turn.tool_calls.is_empty() {
                // Clean end with no content and no calls is authoritative.
                return Err(("对话模型返回了空内容".to_string(), false));
            }
            Ok(turn)
        };

        match run(&primary, messages) {
            Ok(turn) => Ok(turn),
            Err((first_msg, retryable)) => {
                // 视觉回退：带图请求被不支持多模态的模型以 HTTP 4xx 拒绝时，
                // 去图在同路由重试一次，再走直连回退。
                if retryable && has_images(messages) {
                    let stripped = strip_images(messages);
                    match run(&primary, &stripped) {
                        Ok(turn) => return Ok(turn),
                        Err((_, true)) => {
                            if let Some(agent) = &fallback {
                                if let Ok(turn) = run(agent, &stripped) {
                                    return Ok(turn);
                                }
                            }
                        }
                        Err(_) => {}
                    }
                }
                match (&fallback, retryable) {
                    (Some(agent), true) => run(agent, messages).map_err(|(retry_msg, _)| {
                        format!("{first_msg}；回退重试仍失败：{retry_msg}")
                    }),
                    _ => Err(first_msg),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Anthropic Messages protocol adapter
//
// Anthropic 的请求/流式事件形状与 OpenAI 完全不同。这里在 HTTP 层做双向
// 翻译：请求侧把 OpenAI messages / tools / 图片转成 Anthropic blocks；
// 响应侧把 Anthropic SSE 事件翻译成 OpenAI chunk，复用 StreamTurn 的
// 累积逻辑，上层（agent loop / 计费 / 中断）无需感知协议差异。
// ---------------------------------------------------------------------------

/// One image data URL -> Anthropic base64 image block.
fn anthropic_image_block(url: &str) -> Option<serde_json::Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media_type = meta.strip_suffix(";base64")?;
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

/// Append blocks to the last message when the role repeats (Anthropic 要求
/// 消息角色交替；连续的 tool_result 必须合并进同一条 user 消息）。
fn push_anthropic_message(
    out: &mut Vec<(String, Vec<serde_json::Value>)>,
    role: &str,
    blocks: Vec<serde_json::Value>,
) {
    if let Some((last_role, last_blocks)) = out.last_mut() {
        if last_role == role {
            last_blocks.extend(blocks);
            return;
        }
    }
    out.push((role.to_string(), blocks));
}

/// Convert the OpenAI-style message list into (system, Anthropic messages).
fn anthropic_messages(
    messages: &[ChatMessage],
) -> (Option<String>, Vec<serde_json::Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "system" => system_parts.push(message.content.clone()),
            "tool" => {
                let mut content = vec![serde_json::json!({
                    "type": "text",
                    "text": message.content,
                })];
                for image in &message.images {
                    if let Some(block) = anthropic_image_block(image) {
                        content.push(block);
                    }
                }
                let result_content = if content.len() == 1 {
                    serde_json::Value::String(message.content.clone())
                } else {
                    serde_json::Value::Array(content)
                };
                push_anthropic_message(
                    &mut out,
                    "user",
                    vec![serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                        "content": result_content,
                    })],
                );
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": message.content }));
                }
                if let Some(calls) = &message.tool_calls {
                    for call in calls.as_array().into_iter().flatten() {
                        let id = call.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                        let name = call
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let arguments = call
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let input: serde_json::Value = serde_json::from_str(arguments)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }
                if blocks.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": "" }));
                }
                push_anthropic_message(&mut out, "assistant", blocks);
            }
            _ => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": message.content }));
                }
                for image in &message.images {
                    if let Some(block) = anthropic_image_block(image) {
                        blocks.push(block);
                    }
                }
                if blocks.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": "" }));
                }
                push_anthropic_message(&mut out, "user", blocks);
            }
        }
    }
    let messages = out
        .into_iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("

"))
    };
    (system, messages)
}

/// OpenAI tool schema -> Anthropic tool schema.
fn anthropic_tools(tools: &serde_json::Value) -> serde_json::Value {
    let mapped: Vec<serde_json::Value> = tools
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|tool| {
                    let function = tool.get("function")?;
                    let name = function.get("name")?.as_str()?;
                    let mut mapped = serde_json::json!({
                        "name": name,
                        "input_schema": function
                            .get("parameters")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} })),
                    });
                    if let Some(description) =
                        function.get("description").and_then(|v| v.as_str())
                    {
                        mapped["description"] = serde_json::Value::String(description.to_string());
                    }
                    Some(mapped)
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::Value::Array(mapped)
}

/// Build the Anthropic /v1/messages request body.
fn build_anthropic_payload(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&serde_json::Value>,
    stream: bool,
) -> serde_json::Value {
    let (system, converted) = anthropic_messages(messages);
    let mut payload = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "temperature": 0.3,
        "messages": converted,
        "stream": stream,
    });
    if let Some(system) = system {
        payload["system"] = serde_json::Value::String(system);
    }
    if let Some(tools) = tools {
        let mapped = anthropic_tools(tools);
        if mapped.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = mapped;
        }
    }
    payload
}

fn anthropic_finish_reason(stop_reason: &str) -> &'static str {
    match stop_reason {
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        _ => "stop",
    }
}

/// Accumulators carried across Anthropic stream events.
#[derive(Debug, Default)]
struct AnthropicStreamState {
    input_tokens: u64,
    output_tokens: u64,
}

/// Translate one Anthropic stream event into OpenAI-style chunks, so the
/// existing StreamTurn accumulator stays protocol-agnostic.
fn anthropic_events_to_chunks(
    event: &serde_json::Value,
    state: &mut AnthropicStreamState,
) -> Vec<serde_json::Value> {
    let mut chunks = Vec::new();
    match event.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
        "message_start" => {
            state.input_tokens = event
                .pointer("/message/usage/input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or_default();
        }
        "content_block_start" => {
            let index = event.get("index").and_then(|v| v.as_i64()).unwrap_or_default();
            let block = event.get("content_block").cloned().unwrap_or_default();
            match block.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
                "tool_use" => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                    chunks.push(serde_json::json!({
                        "choices": [{ "index": 0, "delta": { "tool_calls": [{
                            "index": index,
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": "" },
                        }]}}]
                    }));
                }
                "text" => {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            chunks.push(serde_json::json!({
                                "choices": [{ "index": 0, "delta": { "content": text } }]
                            }));
                        }
                    }
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let index = event.get("index").and_then(|v| v.as_i64()).unwrap_or_default();
            let delta = event.get("delta").cloned().unwrap_or_default();
            match delta.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
                "text_delta" => {
                    if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                        chunks.push(serde_json::json!({
                            "choices": [{ "index": 0, "delta": { "content": text } }]
                        }));
                    }
                }
                "input_json_delta" => {
                    let partial = delta
                        .get("partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    chunks.push(serde_json::json!({
                        "choices": [{ "index": 0, "delta": { "tool_calls": [{
                            "index": index,
                            "function": { "arguments": partial },
                        }]}}]
                    }));
                }
                _ => {}
            }
        }
        "message_delta" => {
            state.output_tokens = event
                .pointer("/usage/output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(state.output_tokens);
            let finish_reason = event
                .pointer("/delta/stop_reason")
                .and_then(|v| v.as_str())
                .map(anthropic_finish_reason)
                .unwrap_or("stop");
            chunks.push(serde_json::json!({
                "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
                "usage": {
                    "input_tokens": state.input_tokens,
                    "output_tokens": state.output_tokens,
                    "total_tokens": state.input_tokens.saturating_add(state.output_tokens),
                },
            }));
        }
        _ => {}
    }
    chunks
}

/// Extract text content from one Anthropic non-streaming response body.
fn parse_anthropic_content(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析对话响应失败：{err}"))?;
    if let Some(message) = value.pointer("/error/message").and_then(|m| m.as_str()) {
        return Err(format!("对话接口报错：{message}"));
    }
    let content = value
        .get("content")
        .and_then(|items| items.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|block| block.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("对话模型返回了空内容".to_string());
    }
    Ok(content)
}

/// Extract `choices[0].message.content` plus the non-streaming `usage`
/// object from a chat completion body. The usage side-channel is what
/// metered callers consume; title naming only reads the content.
fn parse_chat_body(body: &str) -> Result<(String, Option<TokenUsage>), String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析对话响应失败：{err}"))?;
    if let Some(message) = value.pointer("/error/message").and_then(|m| m.as_str()) {
        return Err(format!("对话接口报错：{message}"));
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("对话模型返回了空内容".to_string());
    }
    Ok((content, parse_provider_usage(value.get("usage"))))
}

/// Content-only view of [`parse_chat_body`] (usage intentionally dropped).
fn parse_chat_content(body: &str) -> Result<String, String> {
    parse_chat_body(body).map(|(content, _usage)| content)
}

/// Clip long error bodies for display.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.trim().to_string()
    } else {
        let cut: String = text.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_content_extracted_and_validated() {
        let body = r#"{
            "choices": [ { "message": { "role": "assistant", "content": "  答案 [1] " } } ]
        }"#;
        assert_eq!(parse_chat_content(body).unwrap(), "答案 [1]");
        assert!(parse_chat_content(r#"{"error": {"message": "bad key"}}"#)
            .unwrap_err()
            .contains("bad key"));
        assert!(parse_chat_content(r#"{"choices": []}"#).is_err());
    }

    #[test]
    fn provider_endpoints_join_correctly() {
        assert_eq!(
            openai_chat_endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_endpoint("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        // Anthropic 官方 / 编程套餐网关：Base 不含 /v1，端点补 /v1/messages。
        assert_eq!(
            anthropic_chat_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_chat_endpoint("https://api.minimax.io/anthropic"),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_eq!(
            anthropic_chat_endpoint("https://api.kimi.com/coding/"),
            "https://api.kimi.com/coding/v1/messages"
        );
    }

    #[test]
    fn anthropic_payload_converts_system_tools_and_tool_results() {
        let assistant = ChatMessage::assistant_with_tool_calls(
            String::new(),
            serde_json::json!([{
                "id": "call-1",
                "type": "function",
                "function": { "name": "vector_search", "arguments": "{\"query\":\"检索\"}" }
            }]),
        );
        let messages = [
            ChatMessage::new("system", "系统提示"),
            ChatMessage::new("user", "问题"),
            assistant,
            ChatMessage::tool_result("call-1".to_string(), "结果".to_string()),
        ];
        let tools = serde_json::json!([{
            "type": "function",
            "function": {
                "name": "vector_search",
                "description": "检索",
                "parameters": { "type": "object", "properties": {} }
            }
        }]);
        let payload = build_anthropic_payload("claude-sonnet-4-5", &messages, Some(&tools), true);
        assert_eq!(payload["system"], "系统提示");
        assert_eq!(payload["stream"], true);
        let converted = payload["messages"].as_array().expect("messages");
        assert_eq!(converted[0]["role"], "user");
        assert_eq!(converted[1]["role"], "assistant");
        assert_eq!(converted[1]["content"][0]["type"], "tool_use");
        assert_eq!(converted[1]["content"][0]["input"]["query"], "检索");
        assert_eq!(converted[2]["role"], "user");
        assert_eq!(converted[2]["content"][0]["type"], "tool_result");
        assert_eq!(payload["tools"][0]["name"], "vector_search");
        assert_eq!(payload["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn anthropic_stream_events_map_to_openai_chunks() {
        let mut state = AnthropicStreamState::default();
        let start = serde_json::json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 12 } }
        });
        let mut turn = StreamTurn::default();
        for chunk in anthropic_events_to_chunks(&start, &mut state) {
            turn.apply_chunk(&chunk);
        }
        let text = serde_json::json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "你好" }
        });
        for chunk in anthropic_events_to_chunks(&text, &mut state) {
            turn.apply_chunk(&chunk);
        }
        assert_eq!(turn.content, "你好");

        let tool_start = serde_json::json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "tool-1", "name": "vector_search" }
        });
        for chunk in anthropic_events_to_chunks(&tool_start, &mut state) {
            turn.apply_chunk(&chunk);
        }
        let tool_args = serde_json::json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"query\":\"x\"}" }
        });
        for chunk in anthropic_events_to_chunks(&tool_args, &mut state) {
            turn.apply_chunk(&chunk);
        }
        let delta = serde_json::json!({
            "type": "message_delta",
            "delta": { "stop_reason": "tool_use" },
            "usage": { "output_tokens": 7 }
        });
        for chunk in anthropic_events_to_chunks(&delta, &mut state) {
            turn.apply_chunk(&chunk);
        }
        turn.tool_calls = turn.take_tool_calls();
        assert_eq!(turn.finish_reason, "tool_calls");
        assert_eq!(turn.tool_calls[0].name, "vector_search");
        assert_eq!(turn.tool_calls[0].arguments, "{\"query\":\"x\"}");
        let usage = turn.usage.expect("usage");
        assert_eq!((usage.input_tokens, usage.output_tokens), (12, 7));
    }

    #[test]
    fn stream_turn_assembles_content_tools_and_finish_reason() {
        let mut turn = StreamTurn::default();
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": { "role": "assistant" }, "finish_reason": null }]
        }));
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": { "content": "你" }, "finish_reason": null }]
        }));
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": {
                "tool_calls": [ { "index": 0, "id": "call-1",
                                  "function": { "name": "vector_search", "arguments": "{\"query\"" } } ]
            }, "finish_reason": null }]
        }));
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": { "content": "好" }, "finish_reason": null }]
        }));
        // Argument fragments arrive split; same-index fragments concatenate.
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": {
                "tool_calls": [ { "index": 0, "function": { "arguments": ":\"检索\"}" } } ]
            }, "finish_reason": "tool_calls" }]
        }));

        let calls = turn.take_tool_calls();
        assert_eq!(turn.content, "你好");
        assert_eq!(turn.finish_reason, "tool_calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "vector_search");
        assert_eq!(calls[0].arguments, r#"{"query":"检索"}"#);
    }

    #[test]
    fn stream_payload_carries_messages_and_flag() {
        let messages = [
            ChatMessage::new("system", "系统提示"),
            ChatMessage::new("user", "问题"),
            ChatMessage::new("assistant", "回答"),
        ];
        let payload = build_stream_payload("qwen-flash", &messages);
        assert_eq!(payload["model"], "qwen-flash");
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["temperature"], 0.3);
        let roles: Vec<&str> = payload["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant"]);
        assert_eq!(payload["messages"][2]["content"], "回答");
        // Streaming requests ask the provider for a usage frame by default.
        assert_eq!(payload["stream_options"]["include_usage"], true);
    }

    #[test]
    fn stream_turn_parses_usage_from_choices_empty_frame() {
        let mut turn = StreamTurn::default();
        turn.apply_chunk(&serde_json::json!({
            "choices": [{ "delta": { "content": "答" }, "finish_reason": null }]
        }));
        assert!(turn.usage.is_none(), "intermediate frames carry no usage");
        // Final frame: choices is empty, usage rides alongside.
        turn.apply_chunk(&serde_json::json!({
            "choices": [],
            "usage": { "prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500 }
        }));
        let usage = turn.usage.expect("usage parsed");
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.output_tokens, 300);
        assert_eq!(usage.total_tokens, 1500);
        assert_eq!(turn.content, "答");
    }

    #[test]
    fn usage_parser_defaults_missing_fields_and_aliases() {
        // OpenAI / DashScope shape, complete.
        let usage = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12
        })))
        .expect("usage");
        assert_eq!(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens),
            (7, 5, 12)
        );
        // Missing total is derived from the halves.
        let derived = parse_provider_usage(Some(&serde_json::json!({
            "prompt_tokens": 4, "completion_tokens": 6
        })))
        .expect("usage");
        assert_eq!(derived.total_tokens, 10);
        // Missing fields fall back to 0.
        let partial =
            parse_provider_usage(Some(&serde_json::json!({ "completion_tokens": 3 })))
                .expect("usage");
        assert_eq!(
            (partial.input_tokens, partial.output_tokens, partial.total_tokens),
            (0, 3, 3)
        );
        // input_tokens / output_tokens aliases are accepted too.
        let aliased = parse_provider_usage(Some(&serde_json::json!({
            "input_tokens": 2, "output_tokens": 8
        })))
        .expect("usage");
        assert_eq!(aliased.total_tokens, 10);
        // Nothing usable: no usage frame must never zero out earlier data.
        assert!(parse_provider_usage(None).is_none());
        assert!(parse_provider_usage(Some(&serde_json::json!(null))).is_none());
        assert!(parse_provider_usage(Some(&serde_json::json!({}))).is_none());
    }

    #[test]
    fn token_usage_merges_and_serializes_camel_case() {
        let mut total = TokenUsage {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
        };
        total.merge(TokenUsage {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
        });
        assert_eq!(
            (total.input_tokens, total.output_tokens, total.total_tokens),
            (11, 22, 33)
        );
        let value = serde_json::to_value(total).expect("serialize");
        assert_eq!(value["inputTokens"], 11);
        assert_eq!(value["outputTokens"], 22);
        assert_eq!(value["totalTokens"], 33);
        // The DB column stores exactly this JSON and round-trips losslessly.
        let parsed: TokenUsage = serde_json::from_value(value).expect("deserialize");
        assert_eq!(parsed, total);
        assert!(TokenUsage::default().is_empty());
        assert!(!total.is_empty());
    }

    #[test]
    fn non_stream_body_exposes_content_and_usage() {
        let body = r#"{
            "choices": [ { "message": { "role": "assistant", "content": "答案" } } ],
            "usage": { "prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13 }
        }"#;
        let (content, usage) = parse_chat_body(body).expect("parse");
        assert_eq!(content, "答案");
        let usage = usage.expect("usage");
        assert_eq!(usage.total_tokens, 13);
        // Bodies without usage still yield content (backward compatible).
        let (content, usage) =
            parse_chat_body(r#"{"choices":[{"message":{"content":"x"}}]}"#).expect("parse");
        assert_eq!(content, "x");
        assert!(usage.is_none());
    }
}
