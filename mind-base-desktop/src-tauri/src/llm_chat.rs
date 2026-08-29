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

use crate::api_keys;

/// Overall cap for one streamed completion (ureq's total timeout includes
/// reading the body, so this bounds the whole generation).
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// Cheap default for unconfigured DashScope chat (mirrors the backend's
/// extraction-tier model choice).
const DASHSCOPE_DEFAULT_MODEL: &str = "qwen-flash";
const DEEPSEEK_DEFAULT_MODEL: &str = "deepseek-chat";

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
}

impl ChatMessage {
    pub(crate) fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    /// Assistant message carrying requested tool calls (request shape).
    pub(crate) fn assistant_with_tool_calls(content: String, tool_calls: serde_json::Value) -> Self {
        Self {
            role: "assistant".to_string(),
            content,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
        }
    }

    /// Tool execution result answering one call id.
    pub(crate) fn tool_result(tool_call_id: String, content: String) -> Self {
        Self {
            role: "tool".to_string(),
            content,
            tool_calls: None,
            tool_call_id: Some(tool_call_id),
        }
    }

    /// Request-body JSON for this message.
    fn to_payload(&self) -> serde_json::Value {
        let mut value = serde_json::json!({ "role": self.role, "content": self.content });
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

/// Outcome of one streamed assistant turn. Accumulates text deltas, finish
/// reason and tool-call fragments (the wire format splits each call's
/// id/name/arguments across many chunks, keyed by index).
#[derive(Debug, Default)]
pub(crate) struct StreamTurn {
    pub content: String,
    pub finish_reason: String,
    pub tool_calls: Vec<ToolCallReq>,
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
        if let Some(reason) = chunk
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str())
        {
            if !reason.is_empty() {
                self.finish_reason = reason.to_string();
            }
        }
        if let Some(content) = chunk.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
            self.content.push_str(content);
        }
        if let Some(fragments) = chunk.pointer("/choices/0/delta/tool_calls").and_then(|v| v.as_array()) {
            for fragment in fragments {
                let index = fragment.get("index").and_then(|v| v.as_i64()).unwrap_or_default();
                let id = fragment.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let name = fragment
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let arguments = fragment
                    .pointer("/function/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match self.fragments.iter_mut().find(|(existing, ..)| *existing == index) {
                    Some((_, existing_id, existing_name, existing_args)) => {
                        if !id.is_empty() {
                            *existing_id = id.to_string();
                        }
                        if !name.is_empty() {
                            *existing_name = name.to_string();
                        }
                        existing_args.push_str(arguments);
                    }
                    None => self
                        .fragments
                        .push((index, id.to_string(), name.to_string(), arguments.to_string())),
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
            .map(|(_, id, name, arguments)| ToolCallReq { id, name, arguments })
            .collect();
        calls.sort_by_key(|call| call.id.clone());
        calls
    }

    /// True when the model asked for tools instead of answering.
    pub(crate) fn wants_tools(&self) -> bool {
        !self.tool_calls.is_empty()
    }
}

/// Build the streaming chat-completions request body. Pure for tests.
pub(crate) fn build_stream_payload(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": messages.iter().map(ChatMessage::to_payload).collect::<Vec<_>>(),
        "temperature": 0.3,
        "stream": true
    })
}

/// Which provider backs this client.
#[derive(Debug, PartialEq, Eq, Clone)]
pub(crate) enum ChatProvider {
    DashScope,
    DeepSeek,
    OpenRouter,
}

impl ChatProvider {
    fn endpoint(&self, custom_base: &str) -> String {
        let base = if custom_base.trim().is_empty() {
            api_keys::default_endpoint(self.as_str()).to_string()
        } else {
            custom_base.trim().trim_end_matches('/').to_string()
        };
        format!("{base}/chat/completions")
    }

    fn as_str(&self) -> &'static str {
        match self {
            ChatProvider::DashScope => "dashscope",
            ChatProvider::DeepSeek => "deepseek",
            ChatProvider::OpenRouter => "openrouter",
        }
    }
}

/// Build a chat client from stored credentials; `None` when no provider has
/// a key (callers surface a settings hint).
pub(crate) fn chat_client_from_conn(conn: &Connection) -> Result<Option<ChatClient>, String> {
    // 用户在「API 设置」里指定的默认提供方优先——前提是它真的配了密钥；
    // 否则按内置优先级链自动选择。
    let preferred = crate::config::load(conn)?.default_chat_provider;
    if let Some(provider) = preferred.as_deref() {
        if chat_provider_configured(conn, provider)? {
            return Ok(Some(chat_client_for(conn, provider)?));
        }
    }
    for provider in ["dashscope", "deepseek", "openrouter"] {
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
pub(crate) fn chat_client_for(
    conn: &Connection,
    provider: &str,
) -> Result<ChatClient, String> {
    let kind = match provider {
        "dashscope" => ChatProvider::DashScope,
        "deepseek" => ChatProvider::DeepSeek,
        "openrouter" => ChatProvider::OpenRouter,
        other => return Err(format!("未知的对话提供方：{other}")),
    };
    let Some((api_key, custom_base)) = api_keys::read_raw_config(conn, kind.as_str())? else {
        return Err(format!(
            "尚未配置 {} 的 API Key，请在「API 设置」中填写后再使用",
            kind.as_str()
        ));
    };
    let stored_model = api_keys::read_model(conn, kind.as_str())?;
    let model = if stored_model.is_empty() {
        match kind {
            ChatProvider::DashScope => DASHSCOPE_DEFAULT_MODEL.to_string(),
            ChatProvider::DeepSeek => DEEPSEEK_DEFAULT_MODEL.to_string(),
            // OpenRouter has no usable universal default — ask for one.
            ChatProvider::OpenRouter => {
                return Err("请在「API 设置」中为 OpenRouter 配置模型后再使用问答".to_string())
            }
        }
    } else {
        stored_model
    };
    ChatClient::new(kind, custom_base, api_key, model)
}

/// Blocking chat client with the standard direct-then-proxy retry.
#[derive(Clone)]
pub(crate) struct ChatClient {
    endpoint: String,
    api_key: String,
    model: String,
    provider: ChatProvider,
}

impl ChatClient {
    fn new(
        provider: ChatProvider,
        custom_base: String,
        api_key: String,
        model: String,
    ) -> Result<Self, String> {
        Ok(Self {
            endpoint: provider.endpoint(&custom_base),
            api_key,
            model,
            provider,
        })
    }

    pub(crate) fn model_name(&self) -> &str {
        &self.model
    }

    /// One completion through a caller-supplied agent — used for auxiliary
    /// short calls (title generation) that need their own tight timeout.
    pub(crate) fn complete_with(
        &self,
        agent: &ureq::Agent,
        messages: &[ChatMessage],
    ) -> Result<String, String> {
        let payload = build_stream_payload(self.model_name(), messages);
        // Non-streaming endpoint: reuse the same body shape minus "stream".
        let mut payload = payload;
        payload["stream"] = serde_json::Value::Bool(false);
        let response = agent
            .post(&self.endpoint)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_json(payload)
            .map_err(|err| match err {
                ureq::Error::Status(code, response) => {
                    let detail = response.into_string().unwrap_or_default();
                    format!(
                        "对话模型调用失败（{}，HTTP {code}）：{}",
                        self.provider.as_str(),
                        truncate(&detail, 200)
                    )
                }
                other => format!("对话模型请求失败：{other}"),
            })?;
        let body = response
            .into_string()
            .map_err(|err| format!("读取对话响应失败：{err}"))?;
        parse_chat_content(&body)
    }

    /// Non-streaming completion with the standard direct-then-proxy retry and
    /// an explicit timeout — used by short auxiliary jobs (title naming) that
    /// must survive networks where the direct route is blocked.
    pub(crate) fn complete_turn(
        &self,
        timeout: Duration,
        messages: &[ChatMessage],
    ) -> Result<String, String> {
        let direct = api_keys::direct_agent(timeout)?;
        let via_proxy = api_keys::proxied_agent(timeout)?;
        let attempt = |agent: &ureq::Agent| -> Result<String, String> {
            let mut payload = build_stream_payload(self.model_name(), messages);
            payload["stream"] = serde_json::Value::Bool(false);
            let response = agent
                .post(&self.endpoint)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Content-Type", "application/json")
                .send_json(payload)
                .map_err(|err| match err {
                    ureq::Error::Status(code, response) => {
                        let detail = response.into_string().unwrap_or_default();
                        format!(
                            "对话模型调用失败（{}，HTTP {code}）：{}",
                            self.provider.as_str(),
                            truncate(&detail, 200)
                        )
                    }
                    other => format!("对话模型请求失败：{other}"),
                })?;
            let body = response
                .into_string()
                .map_err(|err| format!("读取对话响应失败：{err}"))?;
            parse_chat_content(&body)
        };
        match attempt(&direct) {
            Ok(body) => Ok(body),
            Err(direct_err) => match &via_proxy {
                Some(proxy_agent) => attempt(proxy_agent)
                    .map_err(|proxy_err| format!("{direct_err}；经代理重试仍失败：{proxy_err}")),
                None => Err(direct_err),
            },
        }
    }

    /// Streamed completion over an arbitrary message sequence.
    ///
    /// Every text delta is forwarded through `on_delta` as it arrives; the
    /// concatenated full answer is returned once the stream ends. Proxy retry
    /// only happens when nothing was received yet (`retryable == true`) — a
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
        let direct = api_keys::direct_agent(STREAM_TIMEOUT)?;
        let via_proxy = api_keys::proxied_agent(STREAM_TIMEOUT)?;

        // Err payload: (message, retryable-with-proxy). Declared `mut`: the
        // closure forwards through `&mut on_delta`, so re-invoking it for the
        // proxy retry needs a mutable binding.
        let mut run =
            |agent: &ureq::Agent| -> Result<StreamTurn, (String, bool)> {
                let mut payload = build_stream_payload(&self.model, messages);
                if let Some(tools) = tools.clone() {
                    payload["tools"] = tools;
                }
                let response = agent
                    .post(&self.endpoint)
                    .timeout(STREAM_TIMEOUT)
                    .set("Authorization", &format!("Bearer {}", self.api_key))
                    .set("Content-Type", "application/json")
                    .send_json(payload)
                    .map_err(|err| {
                        let message = match err {
                            ureq::Error::Status(code, response) => {
                                let detail = response.into_string().unwrap_or_default();
                                format!(
                                    "对话模型调用失败（{}，HTTP {code}）：{}",
                                    self.provider.as_str(),
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
                for line in buffered.lines() {
                    // Cancellation is checked per SSE frame: the frame in
                    // flight still applies, then the stream is cut and the
                    // partial turn is returned as-is.
                    if should_stop.is_some_and(|check| check()) {
                        turn.interrupted = true;
                        break;
                    }
                    let line =
                        line.map_err(|err| (format!("读取流式响应中断：{err}"), emitted))?;
                    let Some(payload) = line.strip_prefix("data:") else {
                        continue; // blank separators / comments / non-data frames
                    };
                    if payload.trim() == "[DONE]" {
                        break;
                    }
                    let Ok(chunk) = serde_json::from_str::<serde_json::Value>(payload) else {
                        continue; // provider keep-alives / unparsable frames
                    };
                    // Forward newly arrived text through the callback.
                    let before = turn.content.len();
                    turn.apply_chunk(&chunk);
                    if turn.content.len() > before {
                        emitted = true;
                        on_delta(&turn.content[before..]);
                    }
                }
                turn.tool_calls = turn.take_tool_calls();
                if !turn.interrupted && turn.content.is_empty() && turn.tool_calls.is_empty() {
                    // Clean end with no content and no calls is authoritative.
                    return Err(("对话模型返回了空内容".to_string(), false));
                }
                Ok(turn)
            };

        match run(&direct) {
            Ok(turn) => Ok(turn),
            Err((direct_msg, retryable)) => match (&via_proxy, retryable) {
                (Some(proxy_agent), true) => run(proxy_agent).map_err(|(proxy_msg, _)| {
                    format!("{direct_msg}；经代理重试仍失败：{proxy_msg}")
                }),
                _ => Err(direct_msg),
            },
        }
    }
}

/// Extract `choices[0].message.content` from a chat completion body.
fn parse_chat_content(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析对话响应失败：{err}"))?;
    if let Some(message) = value
        .pointer("/error/message")
        .and_then(|m| m.as_str())
    {
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
    Ok(content)
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
            ChatProvider::DashScope.endpoint(""),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        assert_eq!(
            ChatProvider::OpenRouter.endpoint("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
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
    }
}
