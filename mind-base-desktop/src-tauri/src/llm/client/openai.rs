//! OpenAI-compatible endpoints, request bodies and non-stream response parsing.

use super::types::{ChatMessage, TokenUsage};
use super::usage::parse_provider_usage;

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
pub(super) fn build_non_stream_payload(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut payload = build_stream_payload(model, messages);
    payload["stream"] = serde_json::Value::Bool(false);
    if let Some(object) = payload.as_object_mut() {
        object.remove("stream_options");
    }
    payload
}

/// Join a Base URL with the OpenAI-compatible chat path.
pub(super) fn openai_chat_endpoint(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
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
pub(super) fn parse_chat_content(body: &str) -> Result<String, String> {
    parse_chat_body(body).map(|(content, _usage)| content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::anthropic::anthropic_chat_endpoint;

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
