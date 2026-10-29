//! Anthropic Messages protocol adapter: request conversion + SSE event translation.

use super::types::ChatMessage;

/// Join a Base URL with the Anthropic messages path.
///
/// Anthropic 官方 Base（api.anthropic.com）与 MiniMax / Kimi Coding 等兼容
/// 网关的 Base 都不含 /v1；已经带 /v1 的自定义 Base 只补 /messages。
pub(super) fn anthropic_chat_endpoint(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
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
pub(super) fn build_anthropic_payload(
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
pub(super) struct AnthropicStreamState {
    input_tokens: u64,
    output_tokens: u64,
}

/// Translate one Anthropic stream event into OpenAI-style chunks, so the
/// existing StreamTurn accumulator stays protocol-agnostic.
pub(super) fn anthropic_events_to_chunks(
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
pub(super) fn parse_anthropic_content(body: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::stream::StreamTurn;

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
}
