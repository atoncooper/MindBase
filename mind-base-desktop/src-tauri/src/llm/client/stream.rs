//! Streaming SSE turn assembly and the client's streamed completion loop.

use std::io::BufRead;
use std::time::Duration;

use crate::llm::ai_providers::ApiProtocol;
use crate::llm::api_keys;

use super::anthropic::{anthropic_events_to_chunks, AnthropicStreamState};
use super::types::{truncate, ChatClient, ChatMessage, TokenUsage, ToolCallReq};
use super::usage::parse_provider_usage;
use super::vision::{has_images, strip_images};

/// Overall cap for one streamed completion (ureq's total timeout includes
/// reading the body, so this bounds the whole generation).
const STREAM_TIMEOUT: Duration = Duration::from_secs(300);

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

impl ChatClient {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
